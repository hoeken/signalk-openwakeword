/**
 * Test doubles: a recording Signal K app, a fake signalk-container manager
 * installed on globalThis, a ManagedContainer factory mirroring the plugin's
 * production wiring, and fast RunnerTiming for socket-driven tests.
 */

import {
  ManagedContainer,
  type ContainerManagerApi,
} from "signalk-container-helper";
import {
  buildContainerConfig,
  CONTAINER_NAME,
  IMAGE,
  isSemverTag,
  PLUGIN_ID,
  resolveTag,
  type OpenWakeWordSettings,
} from "../src/config.js";
import type { RunnerTiming } from "../src/service.js";
import type { PluginApp } from "../src/index.js";

export interface FakeApp extends PluginApp {
  statuses: string[];
  pluginErrors: string[];
  errorLogs: string[];
  debugLogs: string[];
  emissions: { name: string; value: any }[];
  deltas: any[];
  saved: object[];
  /** When true, emitPropertyValue throws (PropertyValues global cap). */
  emitThrows: boolean;
}

export function createFakeApp(): FakeApp {
  const app: FakeApp = {
    statuses: [],
    pluginErrors: [],
    errorLogs: [],
    debugLogs: [],
    emissions: [],
    deltas: [],
    saved: [],
    emitThrows: false,
    debug: (msg) => app.debugLogs.push(msg),
    error: (msg) => app.errorLogs.push(msg),
    setPluginStatus: (msg) => app.statuses.push(msg),
    setPluginError: (msg) => app.pluginErrors.push(msg),
    emitPropertyValue: (name, value) => {
      if (app.emitThrows) {
        throw new Error("Max PropertyValues count 1000 exceeded");
      }
      app.emissions.push({ name, value });
    },
    handleMessage: (id, delta) => app.deltas.push({ id, delta }),
    savePluginOptions: (configuration, callback) => {
      app.saved.push(configuration);
      callback(null);
    },
    readPluginOptions: () => ({ configuration: {} }),
  };
  return app;
}

export interface FakeCall {
  method: string;
  args: unknown[];
}

export interface FakeManagerHandle {
  calls: FakeCall[];
  /** Returned by resolveContainerAddress; mutable per test. */
  address: string | null;
  /**
   * When set, ensureRunning awaits this promise before completing (a
   * "ensureRunning.completed" call is recorded when it does) — lets tests
   * interleave stop() with an in-flight container.start().
   */
  ensureRunningGate: Promise<void> | null;
  callsTo(method: string): FakeCall[];
  uninstall(): void;
}

export function installFakeManager(
  options: {
    address?: string | null;
    /** Result (or thrower) for the one-shot conversion job. */
    runJob?: (config: unknown) => Promise<unknown>;
    /** Host dir reported as the shared signalk-container data mount. */
    dataMount?: string | null;
    /** Local → host path translation; omit to leave the method undefined. */
    resolveHostPath?: (
      absPath: string,
    ) => Promise<{ source: string; subPath: string } | null>;
  } = {},
): FakeManagerHandle {
  const calls: FakeCall[] = [];
  const handle: FakeManagerHandle = {
    calls,
    address: options.address ?? null,
    ensureRunningGate: null,
    callsTo: (method) => calls.filter((c) => c.method === method),
    uninstall: () => {
      delete (globalThis as { __signalk_containerManager?: unknown })
        .__signalk_containerManager;
    },
  };
  const fake = {
    getRuntime: () => ({ runtime: "docker", version: "0.0-test" }),
    whenReady: async () => {},
    listContainers: async () => [],
    ensureRunning: async (name: string, config: unknown, opts: unknown) => {
      calls.push({ method: "ensureRunning", args: [name, config, opts] });
      if (handle.ensureRunningGate !== null) {
        await handle.ensureRunningGate;
        calls.push({ method: "ensureRunning.completed", args: [name] });
      }
    },
    recreate: async (name: string, config: unknown, opts: unknown) => {
      calls.push({ method: "recreate", args: [name, config, opts] });
    },
    stop: async (name: string) => {
      calls.push({ method: "stop", args: [name] });
    },
    getState: async (name: string) => {
      calls.push({ method: "getState", args: [name] });
      return "running";
    },
    resolveContainerAddress: async (name: string, port: number) => {
      calls.push({ method: "resolveContainerAddress", args: [name, port] });
      return handle.address;
    },
    resolveSignalkDataMount: async () => options.dataMount ?? null,
    // Left undefined unless a test opts in, mirroring an older manager that
    // predates resolveHostPath (1.7.0+) so the fallback path is exercised too.
    ...(options.resolveHostPath === undefined
      ? {}
      : { resolveHostPath: options.resolveHostPath }),
    runJob: async (config: unknown) => {
      calls.push({ method: "runJob", args: [config] });
      if (options.runJob !== undefined) return options.runJob(config);
      return {
        id: "job-test",
        status: "completed",
        image: "test",
        command: [],
        exitCode: 0,
        log: [],
        createdAt: new Date(0).toISOString(),
      };
    },
    updates: {
      register: (reg: unknown) => {
        calls.push({ method: "updates.register", args: [reg] });
      },
      unregister: (pluginId: string) => {
        calls.push({ method: "updates.unregister", args: [pluginId] });
      },
      checkOne: async (pluginId: string) => ({
        pluginId,
        image: IMAGE,
        currentTag: "2.1.0",
        latestTag: "2.1.0",
        hasUpdate: false,
      }),
      checkAll: async () => [],
      getLastResult: () => null,
      sources: {
        dockerHubTags: (image: string, opts?: unknown) => ({
          kind: "dockerHubTags",
          image,
          options: opts,
        }),
        githubReleases: (repo: string, opts?: unknown) => ({
          kind: "githubReleases",
          repo,
          options: opts,
        }),
      },
    },
  };
  (
    globalThis as { __signalk_containerManager?: unknown }
  ).__signalk_containerManager = fake as unknown as ContainerManagerApi;
  return handle;
}

/** ManagedContainer wired exactly like src/index.ts builds it. */
export function makeContainer(
  app: FakeApp,
  settings: OpenWakeWordSettings,
): ManagedContainer {
  return new ManagedContainer({
    app,
    pluginId: PLUGIN_ID,
    name: CONTAINER_NAME,
    image: IMAGE,
    defaultTag: "auto",
    resolveTag,
    buildConfig: (tag) => buildContainerConfig(settings, tag),
    updates: { versionSource: { dockerHubTags: IMAGE, filter: isSemverTag } },
    managerTimeoutMs: 2000,
  });
}

/** Fast, debounce-free timing for real-socket lifecycle tests. */
export const FAST_TIMING: Partial<RunnerTiming> = {
  describeIntervalMs: 20,
  describeTimeoutMs: 200,
  gateDeadlineMs: 3000,
  progressIntervalMs: 60,
  healthIntervalMs: 25,
  healthFailureThreshold: 3,
  emitMinIntervalMs: 0,
  flapWindowMs: 60_000,
  flapLimit: 1000,
};

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Statuses emitted on the wyoming-service property, in order. */
export function emittedStatuses(app: FakeApp): string[] {
  return app.emissions
    .filter((e) => e.name === "wyoming-service")
    .map((e) => e.value.status as string);
}

/** notifications.voice.* values sent via handleMessage, in order. */
export function notificationValues(
  app: FakeApp,
): { path: string; value: any }[] {
  const out: { path: string; value: any }[] = [];
  for (const { delta } of app.deltas) {
    for (const update of delta?.updates ?? []) {
      for (const pathValue of update?.values ?? []) {
        if (
          typeof pathValue?.path === "string" &&
          pathValue.path.startsWith("notifications.voice.")
        ) {
          out.push(pathValue);
        }
      }
    }
  }
  return out;
}
