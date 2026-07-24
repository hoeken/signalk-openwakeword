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
  type ResponseLike,
  type RouterLike,
} from "signalk-container-helper";
import {
  buildContainerConfig,
  CONFIG_SCHEMA,
  CONTAINER_NAME,
  IMAGE,
  isSemverTag,
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

export interface PluginApp extends ServiceApp {
  savePluginOptions(
    configuration: object,
    callback: (err: unknown) => void,
  ): void;
  readPluginOptions?(): { configuration?: Record<string, unknown> } | undefined;
}

type RouteHandler = (req: unknown, res: ResponseLike) => unknown;

export interface PluginRouter extends RouterLike {
  /** Signal K ≥2.x permission registrar; feature-detected. */
  access?(level: "readonly" | "readwrite"): RouterLike;
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
): OpenWakeWordPlugin {
  let running = false;
  let settings: OpenWakeWordSettings = withDefaults(undefined);
  let container: ManagedContainer | null = null;
  let runner: ServiceRunner | null = null;

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
    },
  };
}
