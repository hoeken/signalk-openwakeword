/**
 * signalk-openwakeword — Signal K plugin entry point.
 *
 * Runs rhasspy/wyoming-openwakeword (pinned 2.1.0) as a managed container via
 * signalk-container-helper, gates readiness on a Wyoming `describe` exchange,
 * advertises the service on the shared `wyoming-service` PropertyValues
 * convention, and keeps a protocol-native health loop running.
 */

import {
  ManagedContainer,
  startSafely,
  errMsg,
  fetchWithTimeout,
  type ResponseLike,
  type RouterLike,
} from "signalk-container-helper";
import {
  buildContainerConfig,
  CONFIG_SCHEMA,
  CONTAINER_NAME,
  IMAGE,
  isSemverTag,
  MAX_MODEL_BYTES,
  PLUGIN_ID,
  PLUGIN_NAME,
  resolveTag,
  withDefaults,
  type OpenWakeWordSettings,
} from "./config.js";
import {
  ServiceRunner,
  type RunnerTiming,
  type ServiceApp,
} from "./service.js";
import {
  makeDataMountResolver,
  ModelStore,
  ModelStoreError,
  modelFormat,
  type DataMountResolver,
} from "./models.js";
import { convertOnnxToTflite, ConvertError } from "./convert.js";
import {
  describeErrors,
  parse,
  TrainConfigQuerySchema,
  UploadQuerySchema,
} from "./api-schema.js";
import { buildTrainingPlan } from "./train.js";
import { wakeModelNames } from "./wyoming.js";

export interface PluginApp extends ServiceApp {
  savePluginOptions(
    configuration: object,
    callback: (err: unknown) => void,
  ): void;
  readPluginOptions?(): { configuration?: Record<string, unknown> } | undefined;
  /** This plugin's data dir, as seen by the Signal K process. */
  getDataDirPath?(): string;
}

type RouteHandler = (req: unknown, res: ResponseLike) => unknown;

/** Docker Hub tag listing backing the config panel's version dropdown. */
const TAGS_URL = `https://hub.docker.com/v2/repositories/${IMAGE}/tags/?page_size=25`;

export interface PluginRouter extends RouterLike {
  /** Signal K ≥2.x permission registrar; feature-detected. */
  access?(level: "readonly" | "readwrite"): RouterLike;
  /** Express has it; RouterLike does not declare it. Feature-detected. */
  delete?(
    path: string,
    handler: (req: unknown, res: ResponseLike) => unknown,
  ): unknown;
}

/** The request fields the model routes read. */
interface RequestLike {
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: unknown;
  /** Present when the request is still an unread stream (see readBody). */
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  readable?: boolean;
}

/**
 * Read a model upload out of the request.
 *
 * Signal K registers only the `json` and `urlencoded` body parsers, so an
 * `application/octet-stream` upload arrives as an unconsumed stream and
 * `req.body` is undefined — a plugin that assumes Express handed it a Buffer
 * rejects every real upload. Collect the stream ourselves, capping it at the
 * same limit the store enforces so a runaway request cannot fill the boat's
 * disk before the size check runs.
 */
function readBody(req: RequestLike, limit: number): Promise<Buffer> {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  return new Promise((resolve, reject) => {
    if (typeof req.on !== "function" || req.readable === false) {
      reject(new Error("request body is not readable"));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: unknown) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += buf.length;
      if (total > limit) {
        reject(new Error(`upload exceeds the ${limit}-byte limit`));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", (err: unknown) => reject(err as Error));
  });
}

export interface OpenWakeWordPlugin {
  id: string;
  name: string;
  description: string;
  schema: () => object;
  start: (config: object) => void;
  stop: () => Promise<void>;
  registerWithRouter: (router: PluginRouter) => void;
}

/**
 * Plugin factory. The optional `timing` parameter is a test seam — the
 * Signal K loader only ever passes `app`.
 */
export default function createPlugin(
  app: PluginApp,
  timing: Partial<RunnerTiming> = {},
  resolveDataMount: DataMountResolver = makeDataMountResolver(app),
): OpenWakeWordPlugin {
  let running = false;
  let settings: OpenWakeWordSettings = withDefaults(undefined);
  let container: ManagedContainer | null = null;
  let runner: ServiceRunner | null = null;
  const models = new ModelStore(resolveDataMount);

  // One ManagedContainer per server process: registerWithRouter is called
  // once and Express routes cannot be replaced, so update routes must keep
  // working across stop/start cycles. buildConfig reads the *current*
  // settings, staying pure and deterministic per call.
  const getContainer = (): ManagedContainer => {
    container ??= new ManagedContainer({
      app,
      pluginId: PLUGIN_ID,
      name: CONTAINER_NAME,
      image: IMAGE,
      defaultTag: "auto",
      resolveTag,
      buildConfig: (tag) => buildContainerConfig(settings, tag),
      updates: {
        versionSource: { dockerHubTags: IMAGE, filter: isSemverTag },
      },
      // Wyoming is raw TCP: NO helper `readiness` (HTTP-only). Readiness is
      // gated on our own describe loop; this is the manager's recurring
      // (60 s) liveness hook, which accepts any async boolean.
      ensureOptions: {
        healthCheck: () => runner?.healthProbe() ?? Promise.resolve(true),
        onUnhealthy: (name, error) =>
          app.debug(`container health check failed for ${name}: ${error}`),
      },
    });
    return container;
  };

  const persistRequestedTag = (requestedTag: string): void => {
    settings = { ...settings, imageTag: requestedTag };
    try {
      const wrapper = app.readPluginOptions?.();
      const configuration = {
        ...(wrapper?.configuration ?? {}),
        imageTag: requestedTag,
      };
      app.savePluginOptions(configuration, (err) => {
        if (err) app.error(`failed to persist image tag: ${errMsg(err)}`);
      });
    } catch (err) {
      app.error(`failed to persist image tag: ${errMsg(err)}`);
    }
  };

  /** Convert an uploaded .onnx in place, reporting the validated .tflite. */
  const runConversion = async (
    onnxFilename: string,
  ): Promise<{ filename: string; maxAbsDiff: number }> => {
    const dir = await models.dir();
    app.setPluginStatus(`Converting ${onnxFilename} to TFLite…`);
    try {
      const result = await convertOnnxToTflite(app, dir, onnxFilename);
      app.debug(
        `converted ${onnxFilename} → ${result.filename} ` +
          `(max abs diff ${result.maxAbsDiff})`,
      );
      return { filename: result.filename, maxAbsDiff: result.maxAbsDiff };
    } finally {
      // Never leave the conversion message as the plugin's resting status.
      runner?.refreshStatus();
    }
  };

  /**
   * Restart the wake word service so a newly installed model is actually
   * loaded — it only scans its model directory at startup, so without this a
   * fresh upload stays invisible until the next manual restart.
   *
   * Only worth doing for a `.tflite` (the only format the service reads) and
   * only when custom models are switched on. Returns whether a restart ran, so
   * the UI can say "ready now" instead of "restart to load".
   */
  const reloadForModels = async (format: string): Promise<boolean> => {
    if (format !== "tflite") return false;
    if (!settings.advanced.customModels) return false;
    if (runner === null || !running) return false;
    await runner.reload();
    return true;
  };

  /** Map the module error types onto HTTP without leaking stack traces. */
  const respondError = (res: ResponseLike, err: unknown): void => {
    if (err instanceof ModelStoreError) {
      const status =
        err.code === "not-found"
          ? 404
          : err.code === "exists"
            ? 409
            : err.code === "dir-unavailable"
              ? 503
              : 400;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof ConvertError) {
      const status = err.code === "manager-unavailable" ? 503 : 422;
      res
        .status(status)
        .json({ error: err.message, code: err.code, log: err.log });
      return;
    }
    app.error(`model request failed: ${errMsg(err)}`);
    res.status(500).json({ error: errMsg(err) });
  };

  const guard = (handler: RouteHandler): RouteHandler => {
    return (req, res) => {
      if (!running || runner === null) {
        res.status(503).json({ error: `${PLUGIN_ID} is not running` });
        return;
      }
      return handler(req, res);
    };
  };

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      "Wyoming openWakeWord wake word detection service for Signal K — " +
      `runs ${IMAGE} in a managed container. Fully offline: all wake word ` +
      "models ship inside the image.",

    schema: () => CONFIG_SCHEMA,

    start(rawConfig: object): void {
      running = true;
      settings = withDefaults(rawConfig);
      const active = new ServiceRunner(app, getContainer(), settings, timing);
      runner = active;
      startSafely(app, () => active.start());
    },

    stop(): Promise<void> {
      running = false;
      const active = runner;
      runner = null;
      return active === null ? Promise.resolve() : active.stop();
    },

    registerWithRouter(router: PluginRouter): void {
      // Called once per server process — even while disabled — and routes
      // outlive stop(): every handler is guarded by the running flag.
      const guarded: RouterLike = {
        get: (path, handler) => router.get(path, guard(handler)),
        post: (path, handler) => router.post(path, guard(handler)),
      };
      // Admin-only by default (correct for update apply).
      getContainer().registerUpdateRoutes(guarded, {
        onApplied: (requestedTag, resolvedTag) => {
          persistRequestedTag(requestedTag);
          runner?.afterUpdate(resolvedTag);
        },
      });

      const readonlyRouter =
        typeof router.access === "function"
          ? router.access("readonly")
          : router;
      readonlyRouter.get(
        "/api/status",
        guard(async (_req, res) => {
          try {
            res.json(await (runner as ServiceRunner).statusReport());
          } catch (err) {
            res.status(500).json({ error: errMsg(err) });
          }
        }),
      );

      // ---- Custom wake-word models -------------------------------------
      // None of these are guarded by the running flag. Fixing a bad model is
      // exactly what an operator does while the plugin is down, and the whole
      // point of the webapp is to make that possible without ssh.

      readonlyRouter.get("/api/models", async (_req, res) => {
        try {
          // Cross-reference what the service actually advertises so the UI can
          // distinguish "installed" from "live" — the difference is usually a
          // disabled customModels toggle or a pending restart.
          let advertised: string[] = [];
          try {
            const report = await runner?.statusReport();
            advertised = wakeModelNames(
              (report as { info?: Record<string, unknown> } | undefined)
                ?.info ?? {},
            );
          } catch {
            // Service down: everything simply reports as not live.
          }
          const stored = await models.list();
          res.json({
            customModelsEnabled: settings.advanced.customModels,
            wakeWords: settings.wakeWords,
            models: stored.map((m) => ({
              ...m,
              live: m.format === "tflite" && advertised.includes(m.id),
              selected: settings.wakeWords.includes(m.id),
            })),
          });
        } catch (err) {
          respondError(res, err);
        }
      });

      router.post("/api/models", async (req, res) => {
        const request = req as RequestLike;
        const parsed = parse(UploadQuerySchema, request.query ?? {});
        if (!parsed.ok) {
          res.status(400).json({ error: describeErrors(parsed.errors) });
          return;
        }
        const { filename, convert, overwrite } = parsed.value;
        let body: Buffer;
        try {
          body = await readBody(request, MAX_MODEL_BYTES);
        } catch (err) {
          res.status(400).json({
            error:
              `could not read the uploaded file: ${errMsg(err)}. Send it as ` +
              "the raw request body (Content-Type: application/octet-stream).",
          });
          return;
        }
        try {
          const installed = await models.install(filename, body, {
            ...(overwrite === true ? { overwrite: true } : {}),
          });
          if (installed.format === "tflite" || convert !== true) {
            const reloaded = await reloadForModels(installed.format);
            res.json({ model: installed, converted: null, reloaded });
            return;
          }
          const converted = await runConversion(filename);
          const reloaded = await reloadForModels("tflite");
          res.json({ model: installed, converted, reloaded });
        } catch (err) {
          respondError(res, err);
        }
      });

      router.post("/api/models/:name/convert", async (req, res) => {
        const name = String((req as RequestLike).params?.name ?? "");
        try {
          if (modelFormat(name) !== "onnx") {
            res.status(400).json({
              error: `${name} is not an .onnx file — nothing to convert`,
            });
            return;
          }
          if (!(await models.has(name))) {
            res.status(404).json({ error: `${name} not found` });
            return;
          }
          res.json({ converted: await runConversion(name) });
        } catch (err) {
          respondError(res, err);
        }
      });

      // Express always provides delete(); RouterLike does not declare it.
      router.delete?.("/api/models/:name", async (req, res) => {
        const name = String((req as RequestLike).params?.name ?? "");
        try {
          await models.remove(name);
          // Restart too, so a deleted wake word stops being advertised
          // instead of lingering until the next restart.
          const reloaded = await reloadForModels(modelFormat(name) ?? "");
          res.json({ ok: true, reloaded });
        } catch (err) {
          respondError(res, err);
        }
      });

      // Phrase advice + a pre-filled notebook config. Training itself runs on
      // Colab's GPU: it needs a ~17 GB feature set and CUDA, so it can't run
      // on a Signal K server.
      router.get("/api/train/config", (req, res) => {
        const parsed = parse(
          TrainConfigQuerySchema,
          (req as RequestLike).query ?? {},
        );
        if (!parsed.ok) {
          res.status(400).json({ error: describeErrors(parsed.errors) });
          return;
        }
        res.json(buildTrainingPlan(parsed.value.phrase));
      });

      // Version-dropdown feed for the config panel. Deliberately not
      // guarded by the running flag: the operator picks a tag while the
      // plugin is still disabled, and the route only reaches out on demand.
      readonlyRouter.get("/api/versions", async (_req, res) => {
        try {
          const response = await fetchWithTimeout(TAGS_URL, {
            timeoutMs: 10_000,
          });
          if (!response.ok) {
            res
              .status(502)
              .json({ error: `Docker Hub answered HTTP ${response.status}` });
            return;
          }
          const body = (await response.json()) as {
            results?: { name?: unknown }[];
          };
          const versions = (Array.isArray(body.results) ? body.results : [])
            .map((r) => (typeof r?.name === "string" ? r.name : ""))
            .filter(isSemverTag)
            .sort(compareSemverDesc)
            .map((tag) => ({ tag }));
          res.json({ versions });
        } catch (err) {
          res.status(502).json({ error: errMsg(err) });
        }
      });
    },
  };
}

/** Numeric-descending compare for the plain x.y.z tags isSemverTag admits. */
function compareSemverDesc(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
