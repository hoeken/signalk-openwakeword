import { describe, expect, it } from "vitest";
import {
  BUILTIN_WAKE_WORDS,
  buildCommand,
  buildContainerConfig,
  CONFIG_SCHEMA,
  DEFAULT_SETTINGS,
  isSemverTag,
  PINNED_TAG,
  resolveTag,
  withDefaults,
} from "../src/config.js";

describe("withDefaults", () => {
  it("returns full defaults for undefined config", () => {
    expect(withDefaults(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns defaults for junk input", () => {
    expect(withDefaults(42)).toEqual(DEFAULT_SETTINGS);
    expect(withDefaults("nope")).toEqual(DEFAULT_SETTINGS);
    expect(withDefaults([])).toEqual(DEFAULT_SETTINGS);
  });

  it("merges partial config over defaults", () => {
    const settings = withDefaults({
      threshold: 0.7,
      wakeWords: ["hey_jarvis", "alexa"],
      advanced: { customModels: true },
    });
    expect(settings.threshold).toBe(0.7);
    expect(settings.wakeWords).toEqual(["hey_jarvis", "alexa"]);
    expect(settings.advanced.customModels).toBe(true);
    expect(settings.port).toBe(10400);
    expect(settings.imageTag).toBe("auto");
  });

  it("drops invalid values and empty wake word lists", () => {
    const settings = withDefaults({
      threshold: "high",
      triggerLevel: null,
      wakeWords: ["", "  "],
      bind: "192.168.1.5",
      restartPolicy: "sometimes",
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid advanced fields and trims advertiseHost", () => {
    const settings = withDefaults({
      advanced: { refractorySeconds: 3.5, advertiseHost: " boat.local " },
    });
    expect(settings.advanced.refractorySeconds).toBe(3.5);
    expect(settings.advanced.advertiseHost).toBe("boat.local");
    expect(settings.advanced.customModels).toBe(false);
  });

  it("accepts the loopback bind option", () => {
    expect(withDefaults({ bind: "127.0.0.1" }).bind).toBe("127.0.0.1");
  });
});

describe("resolveTag / isSemverTag", () => {
  it("maps auto to the pinned release", () => {
    expect(resolveTag("auto")).toBe(PINNED_TAG);
    expect(PINNED_TAG).toBe("2.1.0");
  });

  it("passes explicit tags through", () => {
    expect(resolveTag("2.0.0")).toBe("2.0.0");
    expect(resolveTag("latest")).toBe("latest");
  });

  it("accepts only plain numeric semver for update checks", () => {
    expect(isSemverTag("2.1.0")).toBe(true);
    expect(isSemverTag("10.0.3")).toBe(true);
    expect(isSemverTag("latest")).toBe(false);
    expect(isSemverTag("2.1")).toBe(false);
    expect(isSemverTag("v2.1.0")).toBe(false);
  });
});

describe("buildCommand", () => {
  it("always passes threshold and trigger level", () => {
    expect(buildCommand(DEFAULT_SETTINGS)).toEqual([
      "--threshold",
      "0.5",
      "--trigger-level",
      "1",
    ]);
  });

  it("appends refractory seconds when configured", () => {
    const settings = withDefaults({ advanced: { refractorySeconds: 3 } });
    expect(buildCommand(settings)).toEqual([
      "--threshold",
      "0.5",
      "--trigger-level",
      "1",
      "--refractory-seconds",
      "3",
    ]);
  });

  it("appends the custom model dir when custom models are enabled", () => {
    const settings = withDefaults({ advanced: { customModels: true } });
    expect(buildCommand(settings)).toContain("--custom-model-dir");
    expect(buildCommand(settings)).toContain("/data/custom");
  });
});

describe("buildContainerConfig", () => {
  it("publishes the Wyoming port LAN-reachable by default (no signalkAccessiblePorts)", () => {
    const config = buildContainerConfig(DEFAULT_SETTINGS, "2.1.0");
    expect(config.ports).toEqual({ "10400": "0.0.0.0:10400" });
    expect(config).not.toHaveProperty("signalkAccessiblePorts");
    expect(config.image).toBe("rhasspy/wyoming-openwakeword");
    expect(config.tag).toBe("2.1.0");
    expect(config.restart).toBe("unless-stopped");
  });

  it("honors bind and host port overrides", () => {
    const settings = withDefaults({ bind: "127.0.0.1", port: 10499 });
    const config = buildContainerConfig(settings, "2.1.0");
    expect(config.ports).toEqual({ "10400": "127.0.0.1:10499" });
  });

  it("caps memory with swap disabled", () => {
    const config = buildContainerConfig(DEFAULT_SETTINGS, "2.1.0");
    expect(config.resources).toEqual({ memory: "384m", memorySwap: "384m" });
  });

  it("mounts the data dir only when custom models are enabled", () => {
    const off = buildContainerConfig(DEFAULT_SETTINGS, "2.1.0");
    expect(off).not.toHaveProperty("signalkDataMount");
    const on = buildContainerConfig(
      withDefaults({ advanced: { customModels: true } }),
      "2.1.0",
    );
    expect(on.signalkDataMount).toBe("/data");
  });

  it("is pure: identical calls produce deep-equal configs with a stable command", () => {
    const a = buildContainerConfig(DEFAULT_SETTINGS, "2.1.0");
    const b = buildContainerConfig(DEFAULT_SETTINGS, "2.1.0");
    expect(a).toEqual(b);
    expect(Array.isArray(a.command)).toBe(true);
    expect(a.command!.length).toBeGreaterThan(0);
  });
});

describe("CONFIG_SCHEMA", () => {
  const props = (CONFIG_SCHEMA as any).properties;

  it("declares defaults matching DEFAULT_SETTINGS", () => {
    expect(props.imageTag.default).toBe(DEFAULT_SETTINGS.imageTag);
    expect(props.port.default).toBe(DEFAULT_SETTINGS.port);
    expect(props.bind.default).toBe(DEFAULT_SETTINGS.bind);
    expect(props.wakeWords.default).toEqual(DEFAULT_SETTINGS.wakeWords);
    expect(props.threshold.default).toBe(DEFAULT_SETTINGS.threshold);
    expect(props.triggerLevel.default).toBe(DEFAULT_SETTINGS.triggerLevel);
    expect(props.memoryLimit.default).toBe(DEFAULT_SETTINGS.memoryLimit);
    expect(props.restartPolicy.default).toBe(DEFAULT_SETTINGS.restartPolicy);
    expect(props.advanced.properties.customModels.default).toBe(
      DEFAULT_SETTINGS.advanced.customModels,
    );
  });

  it("documents the ok_nabu → okay_nabu rename and the built-in models", () => {
    expect(props.wakeWords.description).toContain("okay_nabu");
    expect(props.wakeWords.description).toContain("ok_nabu");
    for (const word of BUILTIN_WAKE_WORDS) {
      expect(props.wakeWords.description).toContain(word);
    }
  });

  it("carries the LAN-exposure security warning on the bind field", () => {
    expect(props.bind.description).toMatch(/SECURITY/);
    expect(props.bind.enum).toEqual(["0.0.0.0", "127.0.0.1"]);
  });
});
