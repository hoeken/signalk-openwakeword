/**
 * ServiceRunner — one start()/stop() lifecycle of the managed
 * wyoming-openwakeword container:
 *
 *   container.start → resolve address → emit 'starting' → describe gate →
 *   validate info → 'ready' → health loop (periodic describe) → 'error' on
 *   consecutive failures (+ notifications.voice.openwakeword alarm) →
 *   recovery → 'ready'. stop() emits 'stopped' and stops the container.
 *
 * `wyoming-service` PropertyValues emissions follow SPEC §3.1 discipline:
 * only on transitions, ≥500 ms apart (flaps collapse), muted entirely after
 * pathological churn, and never after the server's global cap throws.
 */

import { errMsg, type ManagedContainer } from "signalk-container-helper";
import {
  IMAGE,
  PLUGIN_ID,
  SERVICE_NAME,
  WYOMING_PORT,
  type OpenWakeWordSettings,
} from "./config.js";
import {
  describeService,
  hasWakePrograms,
  wakeModelNames,
  type DescribeResult,
} from "./wyoming.js";

export type ServiceStatus = "starting" | "ready" | "stopped" | "error";

/** The object emitted on the shared `wyoming-service` property (SPEC §3.1). */
export interface WyomingServiceValue {
  plugin: string;
  type: "wake";
  uri: string | null;
  status: ServiceStatus;
  /**
   * The boat's configured wake words, so the orchestrator can wire satellites
   * without the operator retyping them per satellite. SPEC §3.1 allows extra
   * fields and consumers ignore what they don't know, so this is additive.
   *
   * Omitted when nothing is configured — an empty list would be
   * indistinguishable from "deliberately none" on the consumer side.
   */
  wakeWords?: string[];
}

/** The slice of the Signal K plugin `app` object this module uses. */
export interface ServiceApp {
  debug(msg: string): void;
  error(msg: string): void;
  setPluginStatus(msg: string): void;
  setPluginError(msg: string): void;
  emitPropertyValue(name: string, value: unknown): void;
  handleMessage(id: string, delta: unknown): void;
}

export interface RunnerTiming {
  /** Delay between describe attempts while gating readiness. */
  describeIntervalMs: number;
  /** Per-attempt describe timeout (gate + health loop). */
  describeTimeoutMs: number;
  /** Give up gating after this long (models can be slow elsewhere; not here). */
  gateDeadlineMs: number;
  /** How often the gate refreshes the plugin status line. */
  progressIntervalMs: number;
  /** Health loop period. */
  healthIntervalMs: number;
  /** Consecutive describe failures before the service is declared down. */
  healthFailureThreshold: number;
  /** Minimum spacing between wyoming-service emissions. */
  emitMinIntervalMs: number;
  /** Flap detection window / limit (SPEC §3.1). */
  flapWindowMs: number;
  flapLimit: number;
}

export const DEFAULT_TIMING: RunnerTiming = {
  describeIntervalMs: 2_000,
  describeTimeoutMs: 5_000,
  gateDeadlineMs: 600_000,
  progressIntervalMs: 15_000,
  healthIntervalMs: 30_000,
  healthFailureThreshold: 3,
  emitMinIntervalMs: 500,
  flapWindowMs: 60_000,
  flapLimit: 10,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// StatusEmitter
// ---------------------------------------------------------------------------

/** Debounced, flap-aware `wyoming-service` PropertyValues emitter. */
export class StatusEmitter {
  /** Advertised URI; emissions (except 'stopped') are held until it is set. */
  uri: string | null = null;

  /**
   * Wake words advertised alongside the URI, so the orchestrator can wire
   * satellites without the operator configuring them twice. Settable because
   * the runner re-reads settings on every start.
   */
  wakeWords: string[] = [];

  private lastStatus: ServiceStatus | null = null;
  private lastEmitAt = Number.NEGATIVE_INFINITY;
  private pending: ServiceStatus | null = null;
  private timer: NodeJS.Timeout | null = null;
  private emitTimes: number[] = [];
  private capHit = false;
  private muted = false;

  constructor(
    private readonly app: ServiceApp,
    private readonly pluginName: string,
    private readonly minIntervalMs: number,
    private readonly flapWindowMs: number,
    private readonly flapLimit: number,
  ) {}

  /** Last status actually written to PropertyValues (or null). */
  get emitted(): ServiceStatus | null {
    return this.lastStatus;
  }

  /** Emit a status transition (deduped, debounced, flap-muted). */
  emit(status: ServiceStatus): void {
    if (this.capHit || this.muted) return;
    if (status !== "stopped" && this.uri === null) return;
    if (this.timer !== null) {
      // A debounced emission is queued: retarget it. If we are back at the
      // last emitted status the flap collapsed to nothing — cancel.
      if (status === this.lastStatus) {
        clearTimeout(this.timer);
        this.timer = null;
        this.pending = null;
      } else {
        this.pending = status;
      }
      return;
    }
    if (status === this.lastStatus) return;
    const now = Date.now();
    const wait = this.lastEmitAt + this.minIntervalMs - now;
    if (wait > 0) {
      this.pending = status;
      this.timer = setTimeout(() => {
        this.timer = null;
        const queued = this.pending;
        this.pending = null;
        if (queued !== null && queued !== this.lastStatus) this.doEmit(queued);
      }, wait);
      this.timer.unref?.();
      return;
    }
    this.doEmit(status);
  }

  /** Emit immediately (used for 'stopped'), bypassing debounce and mute. */
  emitFinal(status: ServiceStatus): void {
    this.dispose();
    if (this.capHit || status === this.lastStatus) return;
    this.doEmit(status, true);
  }

  /** Cancel any queued emission. */
  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
  }

  private doEmit(status: ServiceStatus, final = false): void {
    const now = Date.now();
    // Final emissions ('stopped') skip flap accounting entirely: they must
    // go out even when the emitter flap-muted earlier in this run.
    if (!final) {
      this.emitTimes = this.emitTimes.filter(
        (t) => now - t < this.flapWindowMs,
      );
      this.emitTimes.push(now);
      if (this.emitTimes.length > this.flapLimit) {
        this.muted = true;
        this.app.error(
          `wyoming-service status is flapping (>${this.flapLimit} ` +
            `transitions in ${Math.round(this.flapWindowMs / 1000)}s) — ` +
            "suppressing further emissions for this run; health probing " +
            "continues",
        );
        return;
      }
    }
    const value: WyomingServiceValue = {
      plugin: this.pluginName,
      type: "wake",
      uri: this.uri,
      status,
      ...(this.wakeWords.length > 0 ? { wakeWords: [...this.wakeWords] } : {}),
    };
    try {
      this.app.emitPropertyValue("wyoming-service", value);
    } catch (err) {
      // The server-wide PropertyValues cap throws for every emitter once
      // hit; disable ourselves rather than crash callers on a full table.
      this.capHit = true;
      this.app.error(
        `emitPropertyValue failed — disabling wyoming-service emissions: ${errMsg(err)}`,
      );
      return;
    }
    this.lastStatus = status;
    this.lastEmitAt = now;
  }
}

// ---------------------------------------------------------------------------
// ServiceRunner
// ---------------------------------------------------------------------------

export interface HealthSample {
  ok: boolean;
  /** Date.now() of the sample. */
  at: number;
  latencyMs: number | null;
}

export class ServiceRunner {
  readonly emitter: StatusEmitter;
  readonly timing: RunnerTiming;

  private stopped = false;
  private generation = 0;
  private status: ServiceStatus = "starting";
  private tag: string | null = null;
  private address: { host: string; port: number } | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private probing = false;
  private consecutiveFails = 0;
  private failed = false;
  private lastHealth: HealthSample | null = null;
  private lastInfo: Record<string, unknown> | null = null;

  constructor(
    private readonly app: ServiceApp,
    private readonly container: ManagedContainer,
    private readonly settings: OpenWakeWordSettings,
    timing: Partial<RunnerTiming> = {},
  ) {
    this.timing = { ...DEFAULT_TIMING, ...timing };
    this.emitter = new StatusEmitter(
      app,
      PLUGIN_ID,
      this.timing.emitMinIntervalMs,
      this.timing.flapWindowMs,
      this.timing.flapLimit,
    );
    // Advertised so signalk-wyoming can wire satellites from this one setting
    // instead of the operator repeating it per satellite.
    this.emitter.wakeWords = settings.wakeWords;
  }

  /**
   * Full startup. Throws ContainerHelperError (already surfaced via
   * setPluginError) on fatal container conditions — call via startSafely.
   */
  async start(): Promise<void> {
    const { tag } = await this.container.start(this.settings.imageTag);
    this.tag = tag;
    if (this.stopped) {
      // stop() ran while container.start() was in flight (e.g. during the
      // first image pull): its container.stop() found nothing to stop, so
      // the container ensureRunning created afterwards would be orphaned —
      // running, LAN-exposed and restart-on-boot while the plugin reports
      // Stopped. Stop it (best effort) before returning.
      try {
        await this.container.stop();
      } catch (err) {
        this.app.debug(`container stop after shutdown failed: ${errMsg(err)}`);
      }
      return;
    }
    await this.probeUntilReady(tag);
  }

  /** Re-resolve the address and re-run the readiness gate (after updates). */
  afterUpdate(resolvedTag: string): void {
    if (this.stopped) return;
    this.tag = resolvedTag;
    void this.probeUntilReady(resolvedTag).catch((err) => {
      this.app.setPluginError(`Re-probe after update failed: ${errMsg(err)}`);
    });
  }

  /**
   * Restart the service so it re-scans its custom-model directory.
   *
   * wyoming-openwakeword globs `--custom-model-dir` once at startup, so a
   * model added afterwards is invisible until the container restarts. Without
   * this, a freshly uploaded wake word stays "installed but not loaded"
   * indefinitely and the only cure is a manual restart.
   *
   * Never throws: a failed reload leaves the running service untouched, and
   * the model still loads on the next ordinary restart.
   */
  async reload(): Promise<void> {
    if (this.stopped) return;
    this.app.debug("restarting the wake word service to pick up model changes");
    try {
      await this.container.stop();
      const { tag } = await this.container.start(this.settings.imageTag);
      if (this.stopped) return;
      this.tag = tag;
      await this.probeUntilReady(tag);
    } catch (err) {
      this.app.error(`could not restart to load new models: ${errMsg(err)}`);
    }
  }

  /** Never throws; awaited by the server via plugin.stop(). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    this.stopHealthLoop();
    this.status = "stopped";
    try {
      this.emitter.emitFinal("stopped");
    } catch (err) {
      this.app.debug(`stopped emission failed: ${errMsg(err)}`);
    }
    try {
      await this.container.stop();
    } catch (err) {
      this.app.debug(`container stop failed: ${errMsg(err)}`);
    }
    try {
      this.app.setPluginStatus("Stopped");
    } catch (err) {
      this.app.debug(`setPluginStatus failed: ${errMsg(err)}`);
    }
  }

  /** TCP-native probe for signalk-container's 60 s recurring healthCheck. */
  async healthProbe(): Promise<boolean> {
    const addr = this.address;
    if (this.stopped) return true;
    if (addr === null) return true; // not resolved yet — nothing to judge
    try {
      await describeService(addr.host, addr.port, {
        timeoutMs: this.timing.describeTimeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Restore the resting status line. Used after a transient message (a model
   * conversion) so the plugin status doesn't stay stuck on it.
   */
  refreshStatus(): void {
    if (this.status === "ready") {
      this.app.setPluginStatus(this.runningStatusLine());
    }
  }

  /** Payload for GET /api/status. */
  async statusReport(): Promise<Record<string, unknown>> {
    return {
      status: this.status,
      uri: this.emitter.uri,
      tag: this.tag,
      containerState: await this.container.getState(),
      lastHealth: this.lastHealth,
      info: this.lastInfo,
    };
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private stale(generation: number): boolean {
    return this.stopped || generation !== this.generation;
  }

  /**
   * The openwakeword port is published via explicit `ports` (never
   * `signalkAccessiblePorts`), so helper resolution may return null (nothing
   * declared) or the raw bind address. Fall back to 127.0.0.1:<hostPort> and
   * never dial a bind-any address.
   */
  private async resolveServiceAddress(): Promise<{
    host: string;
    port: number;
  }> {
    const raw = await this.container.resolveAddress(WYOMING_PORT);
    let host = "127.0.0.1";
    let port = this.settings.port;
    if (raw !== null) {
      const sep = raw.lastIndexOf(":");
      const parsedPort = Number(raw.slice(sep + 1));
      if (sep > 0 && Number.isInteger(parsedPort) && parsedPort > 0) {
        host = raw.slice(0, sep);
        port = parsedPort;
      }
    }
    if (host === "" || host === "0.0.0.0" || host === "::" || host === "[::]") {
      host = "127.0.0.1";
    }
    return { host, port };
  }

  private advertisedUri(addr: { host: string; port: number }): string {
    const host = this.settings.advanced.advertiseHost ?? addr.host;
    return `tcp://${host}:${addr.port}`;
  }

  private async probeUntilReady(tag: string): Promise<void> {
    const generation = ++this.generation;
    this.stopHealthLoop();
    this.failed = false;
    this.consecutiveFails = 0;

    const addr = await this.resolveServiceAddress();
    if (this.stale(generation)) return;
    this.address = addr;
    this.emitter.uri = this.advertisedUri(addr);
    this.status = "starting";
    this.emitter.emit("starting");
    this.app.setPluginStatus(
      `Starting ${IMAGE}:${tag} — wake word models are bundled, ` +
        "nothing to download",
    );

    const startedAt = Date.now();
    const deadline = startedAt + this.timing.gateDeadlineMs;
    let lastProgressAt = startedAt;
    let result: DescribeResult;
    for (;;) {
      try {
        result = await describeService(addr.host, addr.port, {
          timeoutMs: this.timing.describeTimeoutMs,
        });
        if (this.stale(generation)) return;
        break;
      } catch (err) {
        if (this.stale(generation)) return;
        if (Date.now() >= deadline) {
          const seconds = Math.round(this.timing.gateDeadlineMs / 1000);
          const msg =
            `${IMAGE}:${tag} did not answer a Wyoming describe within ` +
            `${seconds}s: ${errMsg(err)}`;
          this.status = "error";
          this.app.setPluginError(msg);
          this.emitter.emit("error");
          this.failed = true;
          this.notify("alarm", msg);
          // Keep probing so a late-arriving service still recovers.
          this.startHealthLoop(generation);
          return;
        }
        const now = Date.now();
        if (now - lastProgressAt >= this.timing.progressIntervalMs) {
          lastProgressAt = now;
          const elapsed = Math.round((now - startedAt) / 1000);
          this.app.setPluginStatus(
            `Starting ${IMAGE}:${tag} — waiting for the wake word service ` +
              `to answer (${elapsed}s)`,
          );
        }
        await sleep(this.timing.describeIntervalMs);
        if (this.stale(generation)) return;
      }
    }

    this.lastInfo = result.info;
    this.validateInfo(result);
    this.becomeReady(generation);
  }

  /** Warnings only — never blocks startup. */
  private validateInfo(result: DescribeResult): void {
    if (result.version !== undefined && !/^1\./.test(result.version)) {
      this.app.error(
        `Wyoming protocol version ${result.version} is outside the ` +
          "supported 1.x range — continuing, but expect breakage",
      );
    }
    if (!hasWakePrograms(result.info)) {
      this.app.error(
        "info response advertises no wake programs — is this really " +
          "wyoming-openwakeword?",
      );
      return;
    }
    const available = wakeModelNames(result.info);
    if (available.length === 0) return;
    const missing = this.settings.wakeWords.filter(
      (word) => !available.includes(word),
    );
    if (missing.length > 0) {
      this.app.error(
        `Configured wake word(s) not available: ${missing.join(", ")}. ` +
          `Available models: ${available.join(", ")}. ` +
          "(openwakeword 2.0.0 renamed ok_nabu to okay_nabu.)",
      );
    }
  }

  private runningStatusLine(): string {
    return (
      `Running ${IMAGE}:${this.tag ?? "?"} at ${this.emitter.uri} — ` +
      `wake words: ${this.settings.wakeWords.join(", ")}`
    );
  }

  private becomeReady(generation: number): void {
    if (this.stale(generation)) return;
    this.consecutiveFails = 0;
    this.failed = false;
    this.status = "ready";
    this.app.setPluginStatus(this.runningStatusLine());
    this.emitter.emit("ready");
    this.notify("normal", "wake word service is healthy");
    this.startHealthLoop(generation);
  }

  private startHealthLoop(generation: number): void {
    this.stopHealthLoop();
    this.healthTimer = setInterval(() => {
      void this.healthTick(generation);
    }, this.timing.healthIntervalMs);
    this.healthTimer.unref?.();
  }

  private stopHealthLoop(): void {
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private async healthTick(generation: number): Promise<void> {
    if (this.probing || this.stale(generation) || this.address === null) {
      return;
    }
    this.probing = true;
    const startedAt = Date.now();
    try {
      const result = await describeService(
        this.address.host,
        this.address.port,
        { timeoutMs: this.timing.describeTimeoutMs },
      );
      if (this.stale(generation)) return;
      this.lastHealth = {
        ok: true,
        at: Date.now(),
        latencyMs: Date.now() - startedAt,
      };
      this.lastInfo = result.info;
      this.consecutiveFails = 0;
      if (this.failed) {
        this.failed = false;
        this.status = "ready";
        this.app.setPluginStatus(this.runningStatusLine());
        this.emitter.emit("ready");
        this.notify("normal", "wake word service recovered");
      }
    } catch (err) {
      if (this.stale(generation)) return;
      this.lastHealth = { ok: false, at: Date.now(), latencyMs: null };
      this.consecutiveFails++;
      if (
        this.consecutiveFails >= this.timing.healthFailureThreshold &&
        !this.failed
      ) {
        this.failed = true;
        this.status = "error";
        const msg =
          `wake word service unreachable (${this.consecutiveFails} ` +
          `consecutive describe failures): ${errMsg(err)}`;
        this.app.setPluginError(msg);
        this.emitter.emit("error");
        this.notify("alarm", msg);
      }
    } finally {
      this.probing = false;
    }
  }

  /** notifications.voice.openwakeword — method [visual] only (no 'sound'). */
  private notify(state: "alarm" | "normal", message: string): void {
    try {
      this.app.handleMessage(PLUGIN_ID, {
        updates: [
          {
            values: [
              {
                path: `notifications.voice.${SERVICE_NAME}`,
                value: { state, method: ["visual"], message },
              },
            ],
          },
        ],
      });
    } catch (err) {
      this.app.debug(`notification delta failed: ${errMsg(err)}`);
    }
  }
}
