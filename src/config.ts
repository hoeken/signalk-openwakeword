/**
 * Configuration: settings type, defaults, JSON schema for the Signal K
 * Plugin Config UI, and the pure settings → container-config mapping.
 */

import type { ContainerConfig } from "signalk-container-helper";

export const PLUGIN_ID = "signalk-openwakeword";
export const PLUGIN_NAME = "openWakeWord (Wyoming)";
export const IMAGE = "rhasspy/wyoming-openwakeword";
/** Tag that `imageTag: "auto"` resolves to. */
export const PINNED_TAG = "2.1.0";
/** Wyoming port inside the container (baked into the image's ENTRYPOINT). */
export const WYOMING_PORT = 10400;
/** Container name (unprefixed; runtime name is `<namespace>-openwakeword`). */
export const CONTAINER_NAME = "openwakeword";
/** Short service name used in `notifications.voice.<service>`. */
export const SERVICE_NAME = "openwakeword";

/**
 * Wake word models bundled with wyoming-openwakeword 2.x. Note the 2.0.0
 * breaking rename: `ok_nabu` → `okay_nabu`.
 */
export const BUILTIN_WAKE_WORDS = [
  "okay_nabu",
  "hey_jarvis",
  "hey_mycroft",
  "alexa",
  "hey_rhasspy",
];

export interface AdvancedSettings {
  /** → --refractory-seconds (upstream default 2.0 when omitted). */
  refractorySeconds?: number;
  /**
   * Mount the shared signalk-container data dir at /data and pass
   * --custom-model-dir /data/custom.
   */
  customModels: boolean;
  /** Replaces the host part of the advertised wyoming-service uri. */
  advertiseHost?: string;
}

export interface OpenWakeWordSettings {
  imageTag: string;
  /** Host TCP port the container's Wyoming port is published on. */
  port: number;
  /** Host interface the port binds to. LAN-reachable by default (see §8). */
  bind: "0.0.0.0" | "127.0.0.1";
  /**
   * Wake words satellites may use. NOT passed to the container (2.x selects
   * models per client via the Wyoming `Detect` event) — validated against
   * the service's `info` response and surfaced for orchestrator/docs use.
   */
  wakeWords: string[];
  /** → --threshold (0–1). */
  threshold: number;
  /** → --trigger-level (activations above threshold before a detection). */
  triggerLevel: number;
  memoryLimit: string;
  restartPolicy: "no" | "unless-stopped" | "always";
  advanced: AdvancedSettings;
}

export const DEFAULT_SETTINGS: OpenWakeWordSettings = {
  imageTag: "auto",
  port: WYOMING_PORT,
  bind: "0.0.0.0",
  wakeWords: ["okay_nabu"],
  threshold: 0.5,
  triggerLevel: 1,
  memoryLimit: "384m",
  restartPolicy: "unless-stopped",
  advanced: {
    customModels: false,
  },
};

/**
 * Merge raw plugin config over the defaults. Signal K does NOT seed schema
 * defaults into a plugin's saved configuration, so every field must be
 * defaulted here. Tolerates missing/malformed input.
 */
export function withDefaults(raw: unknown): OpenWakeWordSettings {
  const cfg = isObject(raw) ? raw : {};
  const adv = isObject(cfg.advanced) ? cfg.advanced : {};
  const settings: OpenWakeWordSettings = {
    imageTag: str(cfg.imageTag) ?? DEFAULT_SETTINGS.imageTag,
    port: num(cfg.port) ?? DEFAULT_SETTINGS.port,
    bind: cfg.bind === "127.0.0.1" ? "127.0.0.1" : DEFAULT_SETTINGS.bind,
    wakeWords: strArray(cfg.wakeWords) ?? [...DEFAULT_SETTINGS.wakeWords],
    threshold: num(cfg.threshold) ?? DEFAULT_SETTINGS.threshold,
    triggerLevel: num(cfg.triggerLevel) ?? DEFAULT_SETTINGS.triggerLevel,
    memoryLimit: str(cfg.memoryLimit) ?? DEFAULT_SETTINGS.memoryLimit,
    restartPolicy:
      cfg.restartPolicy === "no" || cfg.restartPolicy === "always"
        ? cfg.restartPolicy
        : DEFAULT_SETTINGS.restartPolicy,
    advanced: {
      customModels: adv.customModels === true,
    },
  };
  const refractory = num(adv.refractorySeconds);
  if (refractory !== undefined) {
    settings.advanced.refractorySeconds = refractory;
  }
  const advertiseHost = str(adv.advertiseHost);
  if (advertiseHost !== undefined && advertiseHost.trim() !== "") {
    settings.advanced.advertiseHost = advertiseHost.trim();
  }
  return settings;
}

/** Map `auto` to the pinned upstream release; explicit tags pass through. */
export function resolveTag(requested: string): string {
  return requested === "auto" ? PINNED_TAG : requested;
}

/** True for plain numeric semver tags like "2.1.0" (update-check filter). */
export function isSemverTag(tag: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(tag);
}

/**
 * Container CLI args, appended after the image's baked-in
 * `--uri tcp://0.0.0.0:10400`. Always present and deterministic so
 * signalk-container's drift detection never sees a phantom change.
 */
export function buildCommand(settings: OpenWakeWordSettings): string[] {
  const command = [
    "--threshold",
    String(settings.threshold),
    "--trigger-level",
    String(settings.triggerLevel),
  ];
  if (settings.advanced.refractorySeconds !== undefined) {
    command.push(
      "--refractory-seconds",
      String(settings.advanced.refractorySeconds),
    );
  }
  if (settings.advanced.customModels) {
    command.push("--custom-model-dir", "/data/custom");
  }
  return command;
}

/**
 * Pure settings → ContainerConfig mapping (helper `buildConfig`).
 *
 * openWakeWord must be LAN-reachable for remote satellites (SPEC §8), so the
 * port is published explicitly via `ports` with a default bind of 0.0.0.0 —
 * NOT via `signalkAccessiblePorts` (the two must never share a container
 * port: the loopback mapping would overwrite the explicit binding).
 */
export function buildContainerConfig(
  settings: OpenWakeWordSettings,
  tag: string,
): ContainerConfig {
  const config: ContainerConfig = {
    image: IMAGE,
    tag,
    command: buildCommand(settings),
    ports: {
      [String(WYOMING_PORT)]: `${settings.bind}:${settings.port}`,
    },
    restart: settings.restartPolicy,
    resources: {
      memory: settings.memoryLimit,
      memorySwap: settings.memoryLimit,
    },
  };
  if (settings.advanced.customModels) {
    // signalkDataMount resolves to the signalk-container plugin's OWN data
    // directory (one globally-cached app.getDataDirPath() of that plugin,
    // shared by every consumer) — NOT this plugin's. Users drop .tflite
    // files in <signalk>/plugin-config-data/signalk-container/custom/.
    config.signalkDataMount = "/data";
  }
  return config;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  return out.length > 0 ? out : undefined;
}

export const CONFIG_SCHEMA = {
  type: "object",
  properties: {
    wakeWords: {
      type: "array",
      title: "Wake words",
      items: { type: "string" },
      default: [...DEFAULT_SETTINGS.wakeWords],
      description:
        "Wake word models your satellites will use. Built-ins: " +
        `${BUILTIN_WAKE_WORDS.join(", ")}. NOTE: version 2.0.0 renamed ` +
        "ok_nabu to okay_nabu — old configs using ok_nabu silently match " +
        "nothing. This list is not passed to the container (clients select " +
        "models per connection); it is checked against the running service " +
        "and used by the signalk-wyoming orchestrator.",
    },
    threshold: {
      type: "number",
      title: "Detection threshold",
      minimum: 0,
      maximum: 1,
      default: DEFAULT_SETTINGS.threshold,
      description:
        "Wake probability required to activate (0–1). Lower = more " +
        "sensitive but more false wakes.",
    },
    triggerLevel: {
      type: "integer",
      title: "Trigger level",
      minimum: 1,
      default: DEFAULT_SETTINGS.triggerLevel,
      description:
        "Number of activations above the threshold before a detection " +
        "fires. Raise to reduce false wakes in noisy cabins.",
    },
    port: {
      type: "number",
      title: "Host port",
      default: DEFAULT_SETTINGS.port,
      description:
        "Host TCP port the Wyoming service is published on " +
        "(remote satellites connect to tcp://<boat-server>:<this port>).",
    },
    bind: {
      type: "string",
      title: "Bind address",
      enum: ["0.0.0.0", "127.0.0.1"],
      default: DEFAULT_SETTINGS.bind,
      description:
        "SECURITY: the default 0.0.0.0 makes the wake word service " +
        "reachable from your whole network — required for remote " +
        "satellites, and safe-ish (it only ever sees audio that clients " +
        "send it), but Wyoming has no authentication, so firewall or VLAN " +
        "the boat network on marina wifi. Set 127.0.0.1 if every satellite " +
        "runs on this machine.",
    },
    imageTag: {
      type: "string",
      title: "Image tag",
      default: DEFAULT_SETTINGS.imageTag,
      description:
        `Docker tag of ${IMAGE} to run. "auto" pins the tested release ` +
        `(${PINNED_TAG}) and follows plugin updates; set an explicit tag ` +
        "to stay on a specific upstream version.",
    },
    memoryLimit: {
      type: "string",
      title: "Memory limit",
      default: DEFAULT_SETTINGS.memoryLimit,
      description:
        'Container memory cap (e.g. "384m", "1g"). Swap is disabled by ' +
        "setting the swap limit to the same value.",
    },
    restartPolicy: {
      type: "string",
      title: "Restart policy",
      enum: ["no", "unless-stopped", "always"],
      default: DEFAULT_SETTINGS.restartPolicy,
      description: "Container restart policy passed to docker/podman.",
    },
    advanced: {
      type: "object",
      title: "Advanced",
      properties: {
        refractorySeconds: {
          type: "number",
          title: "Refractory seconds",
          description:
            "Minimum seconds between repeated detections of the same wake " +
            "word (--refractory-seconds). Upstream default: 2.0.",
        },
        customModels: {
          type: "boolean",
          title: "Enable custom wake word models",
          default: DEFAULT_SETTINGS.advanced.customModels,
          description:
            "Mount the shared signalk-container plugin data directory into " +
            "the container and load custom .tflite models from its custom/ " +
            "subdirectory (--custom-model-dir /data/custom). Drop model " +
            "files into plugin-config-data/signalk-container/custom/ (NOT " +
            "this plugin's own data directory) and restart the plugin.",
        },
        advertiseHost: {
          type: "string",
          title: "Advertise host",
          description:
            "Overrides the host part of the tcp:// URI advertised to the " +
            "signalk-wyoming orchestrator (for containerized Signal K or " +
            "multi-NIC hosts where 127.0.0.1 is not what consumers should " +
            "dial). Leave empty for automatic.",
        },
      },
    },
  },
};
