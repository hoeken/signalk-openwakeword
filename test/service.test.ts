import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockWyomingServer } from "signalk-wyoming/mock";
import { withDefaults, type OpenWakeWordSettings } from "../src/config.js";
import {
  ServiceRunner,
  StatusEmitter,
  type RunnerTiming,
} from "../src/service.js";
import {
  createFakeApp,
  emittedStatuses,
  FAST_TIMING,
  installFakeManager,
  makeContainer,
  notificationValues,
  waitFor,
  type FakeApp,
  type FakeManagerHandle,
} from "./helpers.js";

let server: MockWyomingServer | null = null;
let manager: FakeManagerHandle | null = null;
let runner: ServiceRunner | null = null;

afterEach(async () => {
  vi.useRealTimers();
  if (runner !== null) await runner.stop();
  runner = null;
  manager?.uninstall();
  manager = null;
  await server?.close();
  server = null;
});

function setup(
  app: FakeApp,
  settings: OpenWakeWordSettings,
  timing: Partial<RunnerTiming> = FAST_TIMING,
): ServiceRunner {
  runner = new ServiceRunner(
    app,
    makeContainer(app, settings),
    settings,
    timing,
  );
  return runner;
}

describe("ServiceRunner lifecycle", () => {
  // Omitted rather than empty: on the consumer side an empty list is
  // indistinguishable from "deliberately no wake detection".
  it("omits wakeWords from the announcement when none are configured", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    const settings = { ...withDefaults({ port }), wakeWords: [] };
    await setup(app, settings).start();

    const emitted = app.emissions
      .filter((e) => e.name === "wyoming-service")
      .map((e) => e.value as Record<string, unknown>);
    expect(emitted.length).toBeGreaterThan(0);
    for (const value of emitted) {
      expect(value).not.toHaveProperty("wakeWords");
    }
  });

  it("start() reaches ready and emits the exact §3.1 object shape", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    await setup(app, withDefaults({ port })).start();

    const uri = `tcp://127.0.0.1:${port}`;
    expect(
      app.emissions
        .filter((e) => e.name === "wyoming-service")
        .map((e) => e.value),
    ).toEqual([
      // wakeWords is an additive §3.1 extension: it lets signalk-wyoming wire
      // satellites from this plugin's setting instead of the operator
      // configuring the same words twice, in two plugins.
      {
        plugin: "signalk-openwakeword",
        type: "wake",
        uri,
        status: "starting",
        wakeWords: ["okay_nabu"],
      },
      {
        plugin: "signalk-openwakeword",
        type: "wake",
        uri,
        status: "ready",
        wakeWords: ["okay_nabu"],
      },
    ]);

    const ensure = manager.callsTo("ensureRunning");
    expect(ensure).toHaveLength(1);
    const [name, config] = ensure[0]!.args as [string, any];
    expect(name).toBe("openwakeword");
    expect(config.image).toBe("rhasspy/wyoming-openwakeword");
    expect(config.tag).toBe("2.1.0"); // auto → pinned
    expect(config.ports).toEqual({ "10400": `0.0.0.0:${port}` });
    expect(config.signalkAccessiblePorts).toBeUndefined();
    expect(manager.callsTo("updates.register")).toHaveLength(1);

    expect(app.statuses.at(-1)).toContain(
      "Running rhasspy/wyoming-openwakeword:2.1.0",
    );
    const lastNote = notificationValues(app).at(-1);
    expect(lastNote?.path).toBe("notifications.voice.openwakeword");
    expect(lastNote?.value.state).toBe("normal");
  });

  it("uses the resolved container address when available", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager({ address: `127.0.0.1:${port}` });
    const app = createFakeApp();
    // settings.port deliberately wrong: the resolved address must win.
    await setup(app, withDefaults({ port: 1 })).start();
    expect(app.emissions.at(-1)?.value.uri).toBe(`tcp://127.0.0.1:${port}`);
  });

  it("normalizes a 0.0.0.0 bind address to 127.0.0.1", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager({ address: `0.0.0.0:${port}` });
    const app = createFakeApp();
    await setup(app, withDefaults({ port: 1 })).start();
    expect(app.emissions.at(-1)?.value.uri).toBe(`tcp://127.0.0.1:${port}`);
  });

  it("advertiseHost replaces the host part of the advertised uri", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    const settings = withDefaults({
      port,
      advanced: { advertiseHost: "boat.local" },
    });
    await setup(app, settings).start();
    expect(app.emissions.at(-1)?.value).toMatchObject({
      status: "ready",
      uri: `tcp://boat.local:${port}`,
    });
  });

  it("warns when configured wake words are missing from the info response", async () => {
    server = new MockWyomingServer({ role: "wake" }); // advertises okay_nabu
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    await setup(app, withDefaults({ port, wakeWords: ["ok_nabu"] })).start();
    const warning = app.errorLogs.find((m) => m.includes("not available"));
    expect(warning).toContain("ok_nabu");
    expect(warning).toContain("okay_nabu");
    expect(emittedStatuses(app).at(-1)).toBe("ready"); // warning, not fatal
  });

  it("warns when the service advertises no wake programs", async () => {
    server = new MockWyomingServer({ role: "custom" }); // empty info
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    await setup(app, withDefaults({ port })).start();
    expect(app.errorLogs.some((m) => m.includes("no wake programs"))).toBe(
      true,
    );
    expect(emittedStatuses(app).at(-1)).toBe("ready");
  });

  it("warns loudly on a non-1.x protocol version without blocking", async () => {
    const raw = net.createServer((socket) => {
      socket.on("data", () => {
        const data = JSON.stringify({
          wake: [{ name: "oww", models: [{ name: "okay_nabu" }] }],
        });
        socket.write(
          JSON.stringify({
            type: "info",
            version: "2.0.0",
            data_length: Buffer.byteLength(data),
          }) + "\n",
        );
        socket.write(data);
      });
    });
    const port = await new Promise<number>((resolve) => {
      raw.listen(0, "127.0.0.1", () => {
        resolve((raw.address() as net.AddressInfo).port);
      });
    });
    try {
      manager = installFakeManager();
      const app = createFakeApp();
      await setup(app, withDefaults({ port })).start();
      expect(
        app.errorLogs.some((m) => m.includes("outside the supported 1.x")),
      ).toBe(true);
      expect(emittedStatuses(app).at(-1)).toBe("ready");
    } finally {
      raw.close();
    }
  });

  it("health loop: consecutive failures raise error + alarm, recovery clears them", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    await setup(app, withDefaults({ port }), {
      ...FAST_TIMING,
      describeTimeoutMs: 60,
    }).start();

    server.hang = true;
    await waitFor(() => emittedStatuses(app).includes("error"));
    expect(app.pluginErrors.some((m) => m.includes("unreachable"))).toBe(true);
    const alarm = notificationValues(app).find(
      (n) => n.value.state === "alarm",
    );
    expect(alarm?.path).toBe("notifications.voice.openwakeword");
    expect(alarm?.value.method).toEqual(["visual"]);

    server.hang = false;
    await waitFor(() => emittedStatuses(app).at(-1) === "ready");
    expect(notificationValues(app).at(-1)?.value.state).toBe("normal");
  });

  it("gate deadline raises error, then the health loop recovers", async () => {
    server = new MockWyomingServer({ role: "wake", hang: true });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    const active = setup(app, withDefaults({ port }), {
      ...FAST_TIMING,
      gateDeadlineMs: 120,
      describeTimeoutMs: 40,
      describeIntervalMs: 10,
    });
    await active.start();
    expect(emittedStatuses(app)).toEqual(["starting", "error"]);
    expect(app.pluginErrors.some((m) => m.includes("did not answer"))).toBe(
      true,
    );

    server.hang = false;
    await waitFor(() => emittedStatuses(app).at(-1) === "ready");
  });

  it("stop() emits stopped, stops the container and sets 'Stopped'", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    const active = setup(app, withDefaults({ port }));
    await active.start();
    await active.stop();
    const last = app.emissions.at(-1)!.value;
    expect(last.status).toBe("stopped");
    expect(last.uri).toBe(`tcp://127.0.0.1:${port}`);
    expect(manager.callsTo("stop")).toHaveLength(1);
    expect(manager.callsTo("stop")[0]!.args[0]).toBe("openwakeword");
    expect(app.statuses.at(-1)).toBe("Stopped");
  });

  it("stop() during an in-flight container.start() stops the late-created container", async () => {
    manager = installFakeManager();
    let release!: () => void;
    manager.ensureRunningGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = createFakeApp();
    const active = setup(app, withDefaults({ port: 1 }));
    const startPromise = active.start();
    // Wait until start() is inside ensureRunning (the "image pull" window).
    await waitFor(() => manager!.callsTo("ensureRunning").length === 1);
    await active.stop(); // manager.stop is a no-op — container not created yet
    release();
    await startPromise;

    // The container that ensureRunning created AFTER stop() must be stopped
    // again — otherwise it is orphaned (running, LAN-exposed, restart=
    // unless-stopped) while the plugin reports Stopped.
    const completedAt = manager.calls.findIndex(
      (c) => c.method === "ensureRunning.completed",
    );
    expect(completedAt).toBeGreaterThanOrEqual(0);
    const stopsAfter = manager.calls
      .slice(completedAt + 1)
      .filter((c) => c.method === "stop");
    expect(stopsAfter).toHaveLength(1);
    expect(stopsAfter[0]!.args[0]).toBe("openwakeword");
    expect(emittedStatuses(app)).not.toContain("ready");
    expect(app.statuses.at(-1)).toBe("Stopped");
  });

  it("stop() during the readiness gate suppresses ready", async () => {
    server = new MockWyomingServer({ role: "wake", hang: true });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    const active = setup(app, withDefaults({ port }));
    const startPromise = active.start();
    await waitFor(() => emittedStatuses(app).includes("starting"));
    await active.stop();
    await startPromise; // resolves via the stale-generation checks
    expect(emittedStatuses(app)).not.toContain("ready");
    expect(emittedStatuses(app).at(-1)).toBe("stopped");
  });

  it("statusReport exposes status, uri, tag, container state, health and info", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    const active = setup(app, withDefaults({ port }));
    await active.start();
    const report = await active.statusReport();
    expect(report.status).toBe("ready");
    expect(report.uri).toBe(`tcp://127.0.0.1:${port}`);
    expect(report.tag).toBe("2.1.0");
    expect(report.containerState).toBe("running");
    expect(report.info).toBeTruthy();
  });

  it("healthProbe reflects service reachability", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    const active = setup(app, withDefaults({ port }), {
      ...FAST_TIMING,
      describeTimeoutMs: 60,
    });
    await active.start();
    await expect(active.healthProbe()).resolves.toBe(true);
    server.hang = true;
    await expect(active.healthProbe()).resolves.toBe(false);
  });
});

describe("StatusEmitter", () => {
  function makeEmitter(
    app: FakeApp,
    minIntervalMs = 500,
    flapLimit = 10,
    flapWindowMs = 60_000,
  ): StatusEmitter {
    return new StatusEmitter(
      app,
      "signalk-openwakeword",
      minIntervalMs,
      flapWindowMs,
      flapLimit,
    );
  }

  it("dedupes identical consecutive statuses", () => {
    const app = createFakeApp();
    const emitter = makeEmitter(app, 0);
    emitter.uri = "tcp://127.0.0.1:10400";
    emitter.emit("ready");
    emitter.emit("ready");
    expect(app.emissions).toHaveLength(1);
  });

  it("holds emissions until the uri is known, except 'stopped'", () => {
    const app = createFakeApp();
    const emitter = makeEmitter(app, 0);
    emitter.emit("starting");
    expect(app.emissions).toHaveLength(0);
    emitter.emit("stopped");
    expect(app.emissions).toHaveLength(1);
    expect(app.emissions[0]!.value).toEqual({
      plugin: "signalk-openwakeword",
      type: "wake",
      uri: null,
      status: "stopped",
    });
  });

  it("collapses flaps inside the min-interval window", () => {
    vi.useFakeTimers();
    const app = createFakeApp();
    const emitter = makeEmitter(app, 500);
    emitter.uri = "tcp://127.0.0.1:10400";

    emitter.emit("starting"); // emitted immediately
    emitter.emit("ready"); // queued
    emitter.emit("error"); // retargets the queued emission
    emitter.emit("ready"); // retargets again
    expect(emittedStatuses(app)).toEqual(["starting"]);
    vi.advanceTimersByTime(500);
    expect(emittedStatuses(app)).toEqual(["starting", "ready"]);

    // A flap that returns to the last emitted status collapses to nothing.
    emitter.emit("error");
    emitter.emit("ready");
    vi.advanceTimersByTime(1000);
    expect(emittedStatuses(app)).toEqual(["starting", "ready"]);
  });

  it("emitFinal bypasses the debounce window", () => {
    vi.useFakeTimers();
    const app = createFakeApp();
    const emitter = makeEmitter(app, 500);
    emitter.uri = "tcp://127.0.0.1:10400";
    emitter.emit("ready");
    emitter.emitFinal("stopped");
    expect(emittedStatuses(app)).toEqual(["ready", "stopped"]);
  });

  it("mutes after excessive flapping and logs a warning", () => {
    const app = createFakeApp();
    const emitter = makeEmitter(app, 0, 3);
    emitter.uri = "tcp://127.0.0.1:10400";
    const sequence = ["starting", "ready", "error", "ready", "error"] as const;
    for (const status of sequence) emitter.emit(status);
    expect(app.emissions).toHaveLength(3);
    expect(app.errorLogs.some((m) => m.includes("flapping"))).toBe(true);
    emitter.emit("ready");
    expect(app.emissions).toHaveLength(3); // still muted
  });

  it("emitFinal('stopped') bypasses the flap mute", () => {
    const app = createFakeApp();
    const emitter = makeEmitter(app, 0, 3);
    emitter.uri = "tcp://127.0.0.1:10400";
    const sequence = ["starting", "ready", "error", "ready", "error"] as const;
    for (const status of sequence) emitter.emit(status); // mutes after 3
    expect(app.emissions).toHaveLength(3);

    emitter.emitFinal("stopped");
    expect(emittedStatuses(app)).toEqual([
      "starting",
      "ready",
      "error",
      "stopped",
    ]);
    // The flapping warning is not re-logged by the final emission.
    expect(app.errorLogs.filter((m) => m.includes("flapping"))).toHaveLength(1);
  });

  it("disables itself when emitPropertyValue throws (global cap)", () => {
    const app = createFakeApp();
    app.emitThrows = true;
    const emitter = makeEmitter(app, 0);
    emitter.uri = "tcp://127.0.0.1:10400";
    emitter.emit("starting");
    emitter.emit("ready");
    expect(app.emissions).toHaveLength(0);
    expect(app.errorLogs.filter((m) => m.includes("disabling")).length).toBe(1);
  });
});
