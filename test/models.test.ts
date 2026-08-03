import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertSafeFilename,
  makeDataMountResolver,
  ModelStore,
  ModelStoreError,
  modelFormat,
  modelId,
} from "../src/models.js";
import { CUSTOM_MODEL_DIRNAME, MAX_MODEL_BYTES } from "../src/config.js";

let dataMount: string;
let store: ModelStore;

beforeEach(async () => {
  dataMount = await fs.mkdtemp(path.join(os.tmpdir(), "oww-models-"));
  store = new ModelStore(async () => dataMount);
});

afterEach(async () => {
  await fs.rm(dataMount, { recursive: true, force: true });
});

describe("modelId", () => {
  it("strips a version suffix from a single-token name", () => {
    expect(modelId("alexa_v0.1.tflite")).toBe("alexa");
    expect(modelId("computer_v2.tflite")).toBe("computer");
  });

  // The regex upstream uses is ^([^_]+)_v[0-9.]+$ — [^_]+ forbids underscores,
  // so a multi-word name keeps its suffix. Users expect "hey_boat" and then
  // wonder why the wake word never fires, so the UI must show this id.
  it("does NOT strip when the name itself contains underscores", () => {
    expect(modelId("hey_boat_v1.tflite")).toBe("hey_boat_v1");
    expect(modelId("okay_nabu_v0.1.tflite")).toBe("okay_nabu_v0.1");
  });

  it("leaves unversioned names alone and ignores the extension", () => {
    expect(modelId("hey_seabird.tflite")).toBe("hey_seabird");
    expect(modelId("hey_seabird.onnx")).toBe("hey_seabird");
  });
});

describe("modelFormat", () => {
  it("recognises both formats case-insensitively", () => {
    expect(modelFormat("a.tflite")).toBe("tflite");
    expect(modelFormat("a.TFLite")).toBe("tflite");
    expect(modelFormat("a.onnx")).toBe("onnx");
  });

  it("rejects anything else", () => {
    expect(modelFormat("a.txt")).toBeNull();
    expect(modelFormat("a.pkl")).toBeNull();
    expect(modelFormat("noextension")).toBeNull();
  });
});

describe("assertSafeFilename", () => {
  it("accepts a plain model filename", () => {
    expect(() => assertSafeFilename("hey_boat.tflite")).not.toThrow();
  });

  it.each([
    "../escape.tflite",
    "/absolute/path.tflite",
    "nested/dir.tflite",
    "..",
    ".",
    "",
    ".hidden.tflite",
  ])("rejects %j", (name) => {
    expect(() => assertSafeFilename(name)).toThrow(ModelStoreError);
  });

  it("rejects an unsupported extension", () => {
    expect(() => assertSafeFilename("model.pkl")).toThrow(/unsupported/i);
  });
});

describe("makeDataMountResolver", () => {
  // Regression: this used to call manager.resolveSignalkDataMount(), which
  // returns the HOST path. When Signal K itself runs in a container the host
  // path does not exist inside it, and every model request died with
  // "EACCES: permission denied, mkdir '/home/dirk'".
  it("derives signalk-container's data dir from our own, staying local", async () => {
    const resolve = makeDataMountResolver({
      getDataDirPath: () =>
        "/home/node/.signalk/plugin-config-data/signalk-openwakeword",
    });
    await expect(resolve()).resolves.toBe(
      "/home/node/.signalk/plugin-config-data/signalk-container",
    );
  });

  it("returns null when the server does not expose a data dir", async () => {
    await expect(makeDataMountResolver({})()).resolves.toBeNull();
  });
});

describe("ModelStore.dir", () => {
  it("creates the custom dir when it does not exist", async () => {
    const dir = await store.dir();
    expect(dir).toBe(path.join(dataMount, CUSTOM_MODEL_DIRNAME));
    await expect(fs.stat(dir)).resolves.toBeTruthy();
  });

  it("reports a clear error when the data mount cannot be resolved", async () => {
    const broken = new ModelStore(async () => null);
    await expect(broken.dir()).rejects.toThrow(/signalk-container/);
  });
});

describe("ModelStore install/list/remove", () => {
  it("installs a model and reports its computed id", async () => {
    const model = await store.install("alexa_v0.1.tflite", Buffer.from("x"));
    expect(model.id).toBe("alexa");
    expect(model.format).toBe("tflite");
    expect(model.bytes).toBe(1);
  });

  it("writes the file where the container will look for it", async () => {
    await store.install("hey_boat.tflite", Buffer.from("data"));
    const onDisk = path.join(
      dataMount,
      CUSTOM_MODEL_DIRNAME,
      "hey_boat.tflite",
    );
    await expect(fs.readFile(onDisk, "utf8")).resolves.toBe("data");
  });

  it("refuses to overwrite unless asked", async () => {
    await store.install("a.tflite", Buffer.from("1"));
    await expect(store.install("a.tflite", Buffer.from("2"))).rejects.toThrow(
      /already exists/,
    );
    const replaced = await store.install("a.tflite", Buffer.from("22"), {
      overwrite: true,
    });
    expect(replaced.bytes).toBe(2);
  });

  it("rejects an empty upload", async () => {
    await expect(store.install("a.tflite", Buffer.alloc(0))).rejects.toThrow(
      /empty/,
    );
  });

  it("rejects an oversized upload", async () => {
    const huge = Buffer.alloc(MAX_MODEL_BYTES + 1);
    await expect(store.install("a.tflite", huge)).rejects.toThrow(/limit/);
  });

  it("leaves no temp file behind after a successful write", async () => {
    await store.install("a.tflite", Buffer.from("1"));
    const entries = await fs.readdir(
      path.join(dataMount, CUSTOM_MODEL_DIRNAME),
    );
    expect(entries).toEqual(["a.tflite"]);
  });

  it("lists models sorted, ignoring non-model files", async () => {
    await store.install("b.tflite", Buffer.from("1"));
    await store.install("a.onnx", Buffer.from("1"));
    await fs.writeFile(
      path.join(dataMount, CUSTOM_MODEL_DIRNAME, "notes.txt"),
      "ignore me",
    );
    const listed = await store.list();
    expect(listed.map((m) => m.filename)).toEqual(["a.onnx", "b.tflite"]);
  });

  it("marks an .onnx as converted once its .tflite sibling exists", async () => {
    await store.install("hey_boat.onnx", Buffer.from("1"));
    let listed = await store.list();
    expect(listed.find((m) => m.format === "onnx")?.converted).toBe(false);

    await store.install("hey_boat.tflite", Buffer.from("1"));
    listed = await store.list();
    expect(listed.find((m) => m.format === "onnx")?.converted).toBe(true);
  });

  it("removes a model and reports a missing one", async () => {
    await store.install("a.tflite", Buffer.from("1"));
    await store.remove("a.tflite");
    expect(await store.has("a.tflite")).toBe(false);
    await expect(store.remove("a.tflite")).rejects.toThrow(/not found/);
  });

  it("refuses to escape the custom dir on remove", async () => {
    await expect(store.remove("../outside.tflite")).rejects.toThrow(
      ModelStoreError,
    );
  });
});
