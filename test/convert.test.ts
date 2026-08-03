import { describe, it, expect, afterEach } from "vitest";
import { convertOnnxToTflite, ConvertError } from "../src/convert.js";
import { CONVERTER_IMAGE, CONVERTER_TAG } from "../src/config.js";
import { installFakeManager, type FakeManagerHandle } from "./helpers.js";

const log = { debug: () => {}, error: () => {} };

let handle: FakeManagerHandle | null = null;

afterEach(() => {
  handle?.uninstall();
  handle = null;
});

function jobResult(lines: string[], overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    status: "completed",
    image: CONVERTER_IMAGE,
    command: [],
    exitCode: 0,
    log: lines,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("convertOnnxToTflite", () => {
  it("returns the converted filename and diff on success", async () => {
    handle = installFakeManager({
      runJob: async () =>
        jobResult([
          "PROBE input=x shape=[1, 16, 96]",
          'RESULT {"file": "hey_boat.tflite", "maxAbsDiff": 0.0}',
        ]),
    });
    const result = await convertOnnxToTflite(
      log,
      "/data/custom",
      "hey_boat.onnx",
    );
    expect(result.filename).toBe("hey_boat.tflite");
    expect(result.maxAbsDiff).toBe(0);
  });

  it("runs the pinned converter image with the model dir mounted read-write", async () => {
    handle = installFakeManager({
      runJob: async () =>
        jobResult(['RESULT {"file": "a.tflite", "maxAbsDiff": 0}']),
    });
    await convertOnnxToTflite(log, "/host/custom", "a.onnx");
    const config = handle.callsTo("runJob")[0]?.args[0] as {
      image: string;
      outputs: Record<string, string>;
      timeout: number;
    };
    expect(config.image).toBe(`${CONVERTER_IMAGE}:${CONVERTER_TAG}`);
    expect(config.outputs).toEqual({ "/work": "/host/custom" });
    expect(config.timeout).toBeGreaterThan(0);
  });

  // A bind-mount source is interpreted by the HOST runtime, so when Signal K
  // runs in a container the local path must be translated first — otherwise
  // podman binds a path that does not exist on the host.
  it("mounts the host path, not the local one, when they differ", async () => {
    handle = installFakeManager({
      resolveHostPath: async (p: string) => ({
        source: p.replace("/home/node", "/home/dirk"),
        subPath: "",
      }),
      runJob: async () =>
        jobResult(['RESULT {"file": "a.tflite", "maxAbsDiff": 0}']),
    });
    await convertOnnxToTflite(
      log,
      "/home/node/.signalk/plugin-config-data/signalk-container/custom",
      "a.onnx",
    );
    const config = handle.callsTo("runJob")[0]?.args[0] as {
      outputs: Record<string, string>;
    };
    expect(config.outputs).toEqual({
      "/work":
        "/home/dirk/.signalk/plugin-config-data/signalk-container/custom",
    });
  });

  it("joins a subPath returned by the host-path translation", async () => {
    handle = installFakeManager({
      resolveHostPath: async () => ({
        source: "/mnt/volume",
        subPath: "plugin-config-data/signalk-container/custom",
      }),
      runJob: async () =>
        jobResult(['RESULT {"file": "a.tflite", "maxAbsDiff": 0}']),
    });
    await convertOnnxToTflite(log, "/data/custom", "a.onnx");
    const config = handle.callsTo("runJob")[0]?.args[0] as {
      outputs: Record<string, string>;
    };
    expect(config.outputs).toEqual({
      "/work": "/mnt/volume/plugin-config-data/signalk-container/custom",
    });
  });

  // The whole reason conversion validates numerically: onnx2tf silently swaps
  // a 3D input's layout, producing a model that scores garbage with no error.
  it("rejects a model whose outputs drifted from the ONNX original", async () => {
    handle = installFakeManager({
      runJob: async () =>
        jobResult(['RESULT {"file": "a.tflite", "maxAbsDiff": 0.16}']),
    });
    await expect(
      convertOnnxToTflite(log, "/data/custom", "a.onnx"),
    ).rejects.toMatchObject({ code: "validation-failed" });
  });

  it("explains an unconvertible legacy model rather than dumping the log", async () => {
    handle = installFakeManager({
      runJob: async () =>
        jobResult(["ERROR unresolved custom op ONNX_IF"], {
          status: "failed",
          exitCode: 2,
        }),
    });
    const err = await convertOnnxToTflite(
      log,
      "/d",
      "hey_jarvis_v0.1.onnx",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConvertError);
    expect((err as ConvertError).code).toBe("conversion-failed");
    expect((err as ConvertError).message).toMatch(/verifier|cannot translate/i);
  });

  it("surfaces a plain conversion failure", async () => {
    handle = installFakeManager({
      runJob: async () =>
        jobResult(["ERROR onnx2tf exited 1"], {
          status: "failed",
          exitCode: 1,
        }),
    });
    await expect(convertOnnxToTflite(log, "/d", "a.onnx")).rejects.toThrow(
      /onnx2tf exited 1/,
    );
  });

  it("fails clearly when the job completes without a result line", async () => {
    handle = installFakeManager({ runJob: async () => jobResult(["noise"]) });
    await expect(convertOnnxToTflite(log, "/d", "a.onnx")).rejects.toThrow(
      /no result/i,
    );
  });

  it("reports an unavailable container runtime as a 503-shaped error", async () => {
    // No fake manager installed at all.
    await expect(
      convertOnnxToTflite(log, "/d", "a.onnx"),
    ).rejects.toMatchObject({ code: "manager-unavailable" });
  });

  it("wraps a throwing job rather than leaking the raw error", async () => {
    handle = installFakeManager({
      runJob: async () => {
        throw new Error("no such image");
      },
    });
    await expect(
      convertOnnxToTflite(log, "/d", "a.onnx"),
    ).rejects.toMatchObject({ code: "conversion-failed" });
  });
});
