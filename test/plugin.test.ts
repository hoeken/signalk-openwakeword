import { afterEach, describe, expect, it, vi } from "vitest";
import { MockWyomingServer } from "signalk-wyoming/mock";
import type { Plugin } from "@signalk/server-api";
import createPlugin, {
  type OpenWakeWordPlugin,
  type PluginRouter,
} from "../src/index.js";
import { CONFIG_SCHEMA } from "../src/config.js";
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
  method: "get" | "post";
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
  });
  const router = {
    ...registrar(null),
    access: (level: "readonly" | "readwrite") => registrar(level),
  } as PluginRouter;
  return { router, routes };
}

function findRoute(
  routes: RecordedRoute[],
  method: "get" | "post",
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

  it("guards every route except /api/versions with the running flag", async () => {
    plugin = createPlugin(createFakeApp(), FAST_TIMING);
    const { router, routes } = makeRouter();
    plugin.registerWithRouter(router);
    for (const route of routes) {
      // /api/versions is deliberately unguarded (see its test below).
      if (route.path === "/api/versions") continue;
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
