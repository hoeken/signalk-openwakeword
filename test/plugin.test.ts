import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockWyomingServer } from "signalk-wyoming/mock";
import type { Plugin } from "@signalk/server-api";
import createPlugin, {
  type OpenWakeWordPlugin,
  type PluginRouter,
} from "../src/index.js";
import { CONFIG_SCHEMA, MAX_MODEL_BYTES } from "../src/config.js";
import {
  createFakeApp,
  emittedStatuses,
  FAST_TIMING,
  installFakeManager,
  waitFor,
  type FakeManagerHandle,
} from "./helpers.js";

let server: MockWyomingServer | null = null;
let manager: FakeManagerHandle | null = null;
let plugin: OpenWakeWordPlugin | null = null;

afterEach(async () => {
  if (plugin !== null) await plugin.stop();
  plugin = null;
  manager?.uninstall();
  manager = null;
  await server?.close();
  server = null;
});

interface RecordedRoute {
  method: "get" | "post" | "delete";
  path: string;
  access: string | null;
  handler: (req: unknown, res: unknown) => unknown;
}

function makeRouter(): { router: PluginRouter; routes: RecordedRoute[] } {
  const routes: RecordedRoute[] = [];
  const registrar = (access: string | null) => ({
    get: (path: string, handler: RecordedRoute["handler"]) =>
      routes.push({ method: "get", path, access, handler }),
    post: (path: string, handler: RecordedRoute["handler"]) =>
      routes.push({ method: "post", path, access, handler }),
    delete: (path: string, handler: RecordedRoute["handler"]) =>
      routes.push({ method: "delete", path, access, handler }),
  });
  const router = {
    ...registrar(null),
    access: (level: "readonly" | "readwrite") => registrar(level),
  } as PluginRouter;
  return { router, routes };
}

function findRoute(
  routes: RecordedRoute[],
  method: "get" | "post" | "delete",
  path: string,
): RecordedRoute {
  const route = routes.find((r) => r.method === method && r.path === path);
  if (route === undefined) throw new Error(`route ${method} ${path} missing`);
  return route;
}

function makeRes() {
  const res = {
    code: 200,
    body: undefined as unknown,
    status(code: number) {
      res.code = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

describe("plugin factory", () => {
  it("default-exports a factory returning a well-formed plugin", () => {
    expect(typeof createPlugin).toBe("function");
    const app = createFakeApp();
    plugin = createPlugin(app);
    expect(plugin.id).toBe("signalk-openwakeword"); // === npm package name
    expect(plugin.name).toBe("openWakeWord (Wyoming)");
    expect(plugin.schema()).toBe(CONFIG_SCHEMA);
    expect(typeof plugin.start).toBe("function");
    expect(typeof plugin.stop).toBe("function");
    expect(typeof plugin.registerWithRouter).toBe("function");
  });

  it("stays structurally compatible with the Signal K Plugin type", () => {
    const core: Pick<Plugin, "id" | "name" | "start" | "stop" | "schema"> =
      createPlugin(createFakeApp(), FAST_TIMING);
    expect(core.id).toBe("signalk-openwakeword");
  });

  it("stop() before start() resolves cleanly", async () => {
    plugin = createPlugin(createFakeApp(), FAST_TIMING);
    await expect(plugin.stop()).resolves.toBeUndefined();
  });

  it("runs the full start → ready → stop lifecycle", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    plugin = createPlugin(app, FAST_TIMING);

    plugin.start({ port });
    await waitFor(() => emittedStatuses(app).at(-1) === "ready");
    expect(manager.callsTo("ensureRunning")).toHaveLength(1);

    await plugin.stop();
    expect(emittedStatuses(app).at(-1)).toBe("stopped");
    expect(manager.callsTo("stop")).toHaveLength(1);
    plugin = null; // already stopped
  });
});

describe("registerWithRouter", () => {
  it("registers update routes (admin) and readonly status/versions routes", () => {
    plugin = createPlugin(createFakeApp(), FAST_TIMING);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);
    expect(findRoute(routes, "get", "/api/update/check").access).toBeNull();
    expect(findRoute(routes, "post", "/api/update/apply").access).toBeNull();
    expect(findRoute(routes, "get", "/api/status").access).toBe("readonly");
    expect(findRoute(routes, "get", "/api/versions").access).toBe("readonly");
  });

  it("falls back to admin-only registration without router.access", () => {
    plugin = createPlugin(createFakeApp(), FAST_TIMING);
    const { router, routes } = makeRouter();
    delete (router as { access?: unknown }).access;
    plugin.registerWithRouter(router);
    expect(findRoute(routes, "get", "/api/status").access).toBeNull();
  });

  it("guards the service routes with the running flag", async () => {
    plugin = createPlugin(createFakeApp(), FAST_TIMING);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);
    // Deliberately unguarded: /api/versions feeds the version dropdown while
    // the plugin is disabled, and the model/train routes exist so an operator
    // can fix a broken custom model — which is done while it is down.
    const unguarded = (path: string) =>
      path === "/api/versions" ||
      path.startsWith("/api/models") ||
      path.startsWith("/api/train");
    for (const route of routes) {
      if (unguarded(route.path)) continue;
      const res = makeRes();
      await route.handler({}, res);
      expect(res.code).toBe(503);
      expect(res.body).toEqual({
        error: "signalk-openwakeword is not running",
      });
    }
  });

  it("serves /api/versions (readonly, unguarded) with semver-sorted Docker Hub tags", async () => {
    plugin = createPlugin(createFakeApp(), FAST_TIMING);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          { name: "latest" },
          { name: "2.0.0" },
          { name: "2.10.2" },
          { name: "2.1.0" },
          { name: "main" },
          { name: 7 },
        ],
      }),
    }));
    try {
      // The plugin was never started: the versions feed must answer while
      // it is disabled so the config panel can populate its dropdown
      // before the operator enables the plugin.
      const res = makeRes();
      await findRoute(routes, "get", "/api/versions").handler({}, res);
      expect(res.code).toBe(200);
      expect(res.body).toEqual({
        versions: [{ tag: "2.10.2" }, { tag: "2.1.0" }, { tag: "2.0.0" }],
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("answers 502 from /api/versions when Docker Hub is unreachable", async () => {
    plugin = createPlugin(createFakeApp(), FAST_TIMING);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);

    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    try {
      const res = makeRes();
      await findRoute(routes, "get", "/api/versions").handler({}, res);
      expect(res.code).toBe(502);
      expect(res.body).toEqual({ error: "network down" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serves the status report once running", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    plugin = createPlugin(app, FAST_TIMING);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);

    plugin.start({ port });
    await waitFor(() => emittedStatuses(app).at(-1) === "ready");

    const res = makeRes();
    await findRoute(routes, "get", "/api/status").handler({}, res);
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({
      status: "ready",
      uri: `tcp://127.0.0.1:${port}`,
      tag: "2.1.0",
      containerState: "running",
    });
  });

  it("update apply persists the requested tag and re-probes readiness", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager();
    const app = createFakeApp();
    plugin = createPlugin(app, FAST_TIMING);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);

    plugin.start({ port });
    await waitFor(() => emittedStatuses(app).at(-1) === "ready");

    const res = makeRes();
    await findRoute(routes, "post", "/api/update/apply").handler(
      { body: { tag: "2.2.2" } },
      res,
    );
    expect(res.body).toEqual({ success: true, tag: "2.2.2" });
    expect(manager.callsTo("recreate")).toHaveLength(1);
    const config = manager.callsTo("recreate")[0]!.args[1] as { tag: string };
    expect(config.tag).toBe("2.2.2");
    expect(app.saved.at(-1)).toMatchObject({ imageTag: "2.2.2" });

    // afterUpdate re-runs the describe gate → a fresh starting/ready pair.
    await waitFor(() => {
      const statuses = emittedStatuses(app);
      return (
        statuses.filter((s) => s === "ready").length >= 2 &&
        statuses.at(-1) === "ready"
      );
    });
  });
});

describe("custom model routes", () => {
  let dataMount: string;

  beforeEach(async () => {
    dataMount = await fs.mkdtemp(path.join(os.tmpdir(), "oww-routes-"));
  });

  afterEach(async () => {
    await fs.rm(dataMount, { recursive: true, force: true });
  });

  /** Register routes without starting the plugin (the disabled-plugin case). */
  function setup() {
    manager = installFakeManager({ dataMount });
    const app = createFakeApp();
    plugin = createPlugin(app, FAST_TIMING, async () => dataMount);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);
    return { app, routes };
  }

  it("registers the model routes with sane access levels", () => {
    const { routes } = setup();
    // Listing is readonly so any authenticated user can see what is installed…
    expect(findRoute(routes, "get", "/api/models").access).toBe("readonly");
    // …while everything that mutates the boat's models is admin-only.
    expect(findRoute(routes, "post", "/api/models").access).toBeNull();
    expect(findRoute(routes, "delete", "/api/models/:name").access).toBeNull();
    expect(
      findRoute(routes, "post", "/api/models/:name/convert").access,
    ).toBeNull();
    expect(findRoute(routes, "get", "/api/train/config").access).toBeNull();
  });

  // Fixing a broken model is exactly what you do while the plugin is down, so
  // these routes deliberately skip the running-flag guard the others use.
  it("serves the model list while the plugin is stopped", async () => {
    const { routes } = setup();
    const res = makeRes();
    await findRoute(routes, "get", "/api/models").handler({}, res);
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ models: [], customModelsEnabled: false });
  });

  // The service loads EVERY model it finds, so "loaded" says nothing about
  // what the boat listens for — only wakeWords does. The UI showed loaded
  // models as "in use", which read as "this is your wake word".
  it("reports whether a model is selected, separately from being loaded", async () => {
    // A started plugin needs something answering Wyoming describe: each upload
    // restarts the service to load the new model, and without a listener that
    // restart waits out the full describe gate before giving up.
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager({ dataMount });
    const app = createFakeApp();
    plugin = createPlugin(app, FAST_TIMING, async () => dataMount);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);
    plugin.start({
      port,
      wakeWords: ["chosen"],
      advanced: { customModels: true },
    });
    await waitFor(() => emittedStatuses(app).at(-1) === "ready");

    for (const name of ["chosen.tflite", "ignored.tflite"]) {
      await findRoute(routes, "post", "/api/models").handler(
        { query: { filename: name }, body: Buffer.from("TFL3xx") },
        makeRes(),
      );
    }
    const res = makeRes();
    await findRoute(routes, "get", "/api/models").handler({}, res);
    const listed = (res.body as { models: { id: string; selected: boolean }[] })
      .models;
    expect(listed.find((m) => m.id === "chosen")?.selected).toBe(true);
    expect(listed.find((m) => m.id === "ignored")?.selected).toBe(false);
  });

  it("uploads a .tflite and reports the id wyoming will advertise", async () => {
    const { routes } = setup();
    const res = makeRes();
    await findRoute(routes, "post", "/api/models").handler(
      { query: { filename: "alexa_v0.1.tflite" }, body: Buffer.from("model") },
      res,
    );
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({
      model: { id: "alexa", format: "tflite" },
    });
  });

  it("rejects an upload whose filename would escape the model dir", async () => {
    const { routes } = setup();
    const res = makeRes();
    await findRoute(routes, "post", "/api/models").handler(
      { query: { filename: "../evil.tflite" }, body: Buffer.from("x") },
      res,
    );
    expect(res.code).toBe(400);
  });

  it("rejects an upload with no file body", async () => {
    const { routes } = setup();
    const res = makeRes();
    await findRoute(routes, "post", "/api/models").handler(
      { query: { filename: "a.tflite" } },
      res,
    );
    expect(res.code).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(
      /raw request body/,
    );
  });

  // Signal K registers only the json and urlencoded body parsers, so a real
  // octet-stream upload arrives as an unconsumed stream with req.body
  // undefined. Assuming Express handed us a Buffer rejected every real upload.
  it("reads an upload that arrives as an unparsed request stream", async () => {
    const { routes } = setup();
    const res = makeRes();
    const listeners: Record<string, (arg?: unknown) => void> = {};
    const req = {
      query: { filename: "streamed.tflite" },
      readable: true,
      on(event: string, listener: (arg?: unknown) => void) {
        listeners[event] = listener;
        return req;
      },
    };
    const pending = findRoute(routes, "post", "/api/models").handler(req, res);
    listeners.data?.(Buffer.from("TFL3-model-bytes"));
    listeners.end?.();
    await pending;
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({ model: { id: "streamed" } });
  });

  it("aborts a streamed upload that exceeds the size limit", async () => {
    const { routes } = setup();
    const res = makeRes();
    const listeners: Record<string, (arg?: unknown) => void> = {};
    const req = {
      query: { filename: "huge.tflite" },
      readable: true,
      on(event: string, listener: (arg?: unknown) => void) {
        listeners[event] = listener;
        return req;
      },
    };
    const pending = findRoute(routes, "post", "/api/models").handler(req, res);
    listeners.data?.(Buffer.alloc(MAX_MODEL_BYTES + 1));
    listeners.end?.();
    await pending;
    expect(res.code).toBe(400);
    expect(String((res.body as { error: string }).error)).toMatch(/limit/);
  });

  it("rejects an upload with a missing filename via schema validation", async () => {
    const { routes } = setup();
    const res = makeRes();
    await findRoute(routes, "post", "/api/models").handler(
      { query: {}, body: Buffer.from("x") },
      res,
    );
    expect(res.code).toBe(400);
  });

  it("converts an uploaded .onnx and installs the result", async () => {
    manager = installFakeManager({
      dataMount,
      runJob: async () => ({
        id: "job",
        status: "completed",
        image: "x",
        command: [],
        exitCode: 0,
        log: ['RESULT {"file": "hey_boat.tflite", "maxAbsDiff": 0}'],
        createdAt: new Date(0).toISOString(),
      }),
    });
    const app = createFakeApp();
    plugin = createPlugin(app, FAST_TIMING, async () => dataMount);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);

    const res = makeRes();
    await findRoute(routes, "post", "/api/models").handler(
      {
        query: { filename: "hey_boat.onnx", convert: "true" },
        body: Buffer.from("onnx"),
      },
      res,
    );
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({
      converted: { filename: "hey_boat.tflite", maxAbsDiff: 0 },
    });
  });

  it("refuses to convert something that is not an .onnx", async () => {
    const { routes } = setup();
    const res = makeRes();
    await findRoute(routes, "post", "/api/models/:name/convert").handler(
      { params: { name: "a.tflite" } },
      res,
    );
    expect(res.code).toBe(400);
  });

  it("404s converting a model that is not installed", async () => {
    const { routes } = setup();
    const res = makeRes();
    await findRoute(routes, "post", "/api/models/:name/convert").handler(
      { params: { name: "missing.onnx" } },
      res,
    );
    expect(res.code).toBe(404);
  });

  it("deletes a model", async () => {
    const { routes } = setup();
    const upload = makeRes();
    await findRoute(routes, "post", "/api/models").handler(
      { query: { filename: "a.tflite" }, body: Buffer.from("x") },
      upload,
    );
    const res = makeRes();
    await findRoute(routes, "delete", "/api/models/:name").handler(
      { params: { name: "a.tflite" } },
      res,
    );
    // reloaded=false because this plugin instance was never started, so there
    // is no running service to restart.
    expect(res.body).toEqual({ ok: true, reloaded: false });
  });

  // wyoming-openwakeword only scans --custom-model-dir at startup, so without
  // an automatic restart a freshly uploaded wake word stays invisible.
  it("restarts the service so a newly uploaded model is actually loaded", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager({ dataMount });
    const app = createFakeApp();
    plugin = createPlugin(app, FAST_TIMING, async () => dataMount);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);

    plugin.start({ port, advanced: { customModels: true } });
    await waitFor(() => emittedStatuses(app).at(-1) === "ready");
    const before = manager.callsTo("ensureRunning").length;

    const res = makeRes();
    await findRoute(routes, "post", "/api/models").handler(
      { query: { filename: "fresh.tflite" }, body: Buffer.from("TFL3xx") },
      res,
    );
    expect(res.body).toMatchObject({ reloaded: true });
    expect(manager.callsTo("stop").length).toBeGreaterThan(0);
    expect(manager.callsTo("ensureRunning").length).toBeGreaterThan(before);
  });

  it("does not restart when custom models are switched off", async () => {
    server = new MockWyomingServer({ role: "wake" });
    const port = await server.listen();
    manager = installFakeManager({ dataMount });
    const app = createFakeApp();
    plugin = createPlugin(app, FAST_TIMING, async () => dataMount);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);

    plugin.start({ port });
    await waitFor(() => emittedStatuses(app).at(-1) === "ready");
    const stops = manager.callsTo("stop").length;

    const res = makeRes();
    await findRoute(routes, "post", "/api/models").handler(
      { query: { filename: "fresh.tflite" }, body: Buffer.from("TFL3xx") },
      res,
    );
    expect(res.body).toMatchObject({ reloaded: false });
    expect(manager.callsTo("stop").length).toBe(stops);
  });

  it("returns a pre-filled training plan for a phrase", async () => {
    const { routes } = setup();
    const res = makeRes();
    await findRoute(routes, "get", "/api/train/config").handler(
      { query: { phrase: "hey seabird" } },
      res,
    );
    expect(res.code).toBe(200);
    expect(res.body).toMatchObject({
      slug: "hey_seabird",
      modelId: "hey_seabird",
    });
  });

  it("rejects a training request with no phrase", async () => {
    const { routes } = setup();
    const res = makeRes();
    await findRoute(routes, "get", "/api/train/config").handler(
      { query: {} },
      res,
    );
    expect(res.code).toBe(400);
  });
});
