/**
 * ONNX → TFLite conversion for custom wake-word models.
 *
 * Why this exists: wyoming-openwakeword 2.x loads `*.tflite` ONLY (it binds
 * libtensorflowlite_c directly and has no ONNX code path), but every
 * maintained openWakeWord training notebook now exports ONNX. Without
 * conversion, "I trained a wake word" and "my boat answers to it" are
 * separated by a toolchain most users can't assemble.
 *
 * It runs as a one-shot container job so the ~1 GB TensorFlow/onnx2tf
 * toolchain is never a dependency of this plugin — it is pulled the first
 * time someone actually converts something, and nothing is left running.
 */

import { errMsg } from "signalk-container-helper";
import {
  CONVERTER_IMAGE,
  CONVERTER_TAG,
  CONVERT_TIMEOUT_SECONDS,
  PLUGIN_ID,
} from "./config.js";

export interface ConvertLogger {
  debug(msg: string): void;
  error(msg: string): void;
}

export interface ConvertResult {
  /** Filename written into the custom dir, e.g. "hey_boat.tflite". */
  filename: string;
  /** Max absolute difference between ONNX and TFLite outputs. */
  maxAbsDiff: number;
  log: string[];
}

export class ConvertError extends Error {
  constructor(
    message: string,
    readonly code:
      | "manager-unavailable"
      | "conversion-failed"
      | "validation-failed"
      | "invalid-model",
    readonly log: string[] = [],
  ) {
    super(message);
    this.name = "ConvertError";
  }
}

/**
 * The conversion is driven by a Python script rather than the onnx2tf CLI
 * because two things must happen that the CLI cannot do on its own.
 *
 * 1. THE LAYOUT SWAP (silent-corruption bug). onnx2tf treats a 3D input as
 *    NCW and helpfully "corrects" it to NWC, so a (1,16,96) openWakeWord
 *    model converts to a (1,96,16) tflite. Nothing errors — the model just
 *    scores garbage forever. The documented overrides (-k/-kt/-kat/-ois) do
 *    NOT prevent it. The fix that works is to pre-transpose the ONNX graph so
 *    onnx2tf's own swap lands back on the original layout.
 *
 * 2. NUMERICAL VALIDATION. A wake word that silently mis-scores is worse than
 *    one that fails loudly, so the converted model is run head-to-head against
 *    onnxruntime on random inputs and rejected on mismatch. This also catches
 *    unresolved custom ops (e.g. the legacy `If`/verifier branch in some old
 *    community models), which otherwise only surface at allocate_tensors().
 */
const CONVERT_SCRIPT = String.raw`
import glob, json, os, sys
import numpy as np, onnx, onnxruntime as ort
from onnx import helper, TensorProto

src, out_dir, stem = sys.argv[1], sys.argv[2], sys.argv[3]

model = onnx.load(src)
g = model.graph
inp = g.input[0]
dims = [d.dim_value if d.dim_value > 0 else 1 for d in inp.type.tensor_type.shape.dim]
print("PROBE input=%s shape=%s" % (inp.name, dims), flush=True)

prepped = os.path.join(out_dir, stem + ".prepped.onnx")
if len(dims) == 3:
    # Pre-transpose so onnx2tf's NCW->NWC swap restores the original layout.
    swapped = [dims[0], dims[2], dims[1]]
    new_in = helper.make_tensor_value_info(inp.name + "_t", TensorProto.FLOAT, swapped)
    node = helper.make_node("Transpose", [new_in.name], [inp.name], perm=[0, 2, 1])
    g.node.insert(0, node)
    g.input.remove(inp)
    g.input.extend([new_in])
    onnx.save(model, prepped)
    print("PROBE pre-transposed %s -> %s" % (dims, swapped), flush=True)
else:
    prepped = src
    print("PROBE no transpose (rank %d)" % len(dims), flush=True)

rc = os.system("onnx2tf -i %s -o %s -osd -n" % (prepped, out_dir))
if rc != 0:
    print("ERROR onnx2tf exited %d" % rc, flush=True)
    sys.exit(2)

produced = sorted(glob.glob(os.path.join(out_dir, "*_float32.tflite"))) or \
           sorted(glob.glob(os.path.join(out_dir, "*.tflite")))
if not produced:
    print("ERROR onnx2tf produced no .tflite", flush=True)
    sys.exit(3)
tflite_path = produced[0]

# Validate against onnxruntime. Import late: the runtime lives in ai_edge_litert
# on newer images and tensorflow.lite on older ones.
try:
    from ai_edge_litert.interpreter import Interpreter
except ImportError:
    from tensorflow.lite.python.interpreter import Interpreter

interp = Interpreter(model_path=tflite_path)
interp.allocate_tensors()
tin, tout = interp.get_input_details()[0], interp.get_output_details()[0]
print("PROBE tflite input=%s" % list(tin["shape"]), flush=True)

sess = ort.InferenceSession(src, providers=["CPUExecutionProvider"])
oin = sess.get_inputs()[0]

worst = 0.0
rng = np.random.default_rng(0)
for _ in range(8):
    x = rng.standard_normal(dims).astype(np.float32)
    ref = sess.run(None, {oin.name: x})[0]
    tx = x if list(tin["shape"]) == list(dims) else np.transpose(x, (0, 2, 1))
    interp.set_tensor(tin["index"], tx.astype(np.float32))
    interp.invoke()
    got = interp.get_tensor(tout["index"])
    worst = max(worst, float(np.max(np.abs(np.asarray(ref).ravel() - np.asarray(got).ravel()))))

final = os.path.join(out_dir, stem + ".tflite")
if os.path.abspath(tflite_path) != os.path.abspath(final):
    os.replace(tflite_path, final)
for junk in glob.glob(os.path.join(out_dir, "*_float32.tflite")) + [prepped]:
    if os.path.abspath(junk) != os.path.abspath(final) and os.path.exists(junk):
        try:
            os.remove(junk)
        except OSError:
            pass

print("RESULT " + json.dumps({"file": os.path.basename(final), "maxAbsDiff": worst}), flush=True)
`;

/**
 * Convert `<stem>.onnx` in the custom-model directory to `<stem>.tflite`.
 *
 * `hostDir` is the host path of the custom-model dir; it is mounted
 * read-write so the job can drop the .tflite straight in beside the source.
 */
export async function convertOnnxToTflite(
  log: ConvertLogger,
  hostDir: string,
  onnxFilename: string,
  maxAbsDiff = 1e-4,
): Promise<ConvertResult> {
  const manager = globalThis.__signalk_containerManager;
  if (manager === undefined) {
    throw new ConvertError(
      "signalk-container is not available — it provides the conversion runtime",
      "manager-unavailable",
    );
  }
  const stem = onnxFilename.replace(/\.onnx$/i, "");
  const lines: string[] = [];
  const collect = (line: string): void => {
    lines.push(line);
    log.debug(`convert: ${line}`);
  };

  let result;
  try {
    result = await manager.runJob({
      image: `${CONVERTER_IMAGE}:${CONVERTER_TAG}`,
      entrypoint: ["/bin/sh", "-lc"],
      command: [
        `printf '%s' "$OWW_SCRIPT" > /tmp/convert.py && ` +
          `python3 /tmp/convert.py /work/${onnxFilename} /work ${stem}`,
      ],
      env: { OWW_SCRIPT: CONVERT_SCRIPT },
      // Read-write: the converted .tflite is written back beside the source.
      outputs: { "/work": hostDir },
      timeout: CONVERT_TIMEOUT_SECONDS,
      label: `openwakeword-convert-${stem}`,
      ownerPluginId: PLUGIN_ID,
      onStdoutLine: collect,
      onStderrLine: collect,
    });
  } catch (err) {
    throw new ConvertError(
      `conversion job failed to run: ${errMsg(err)}`,
      "conversion-failed",
      lines,
    );
  }

  const all = [...lines, ...(result.log ?? [])];
  if (result.status !== "completed" || (result.exitCode ?? 0) !== 0) {
    throw new ConvertError(
      describeFailure(all, result.error),
      "conversion-failed",
      all,
    );
  }

  const summary = parseResult(all);
  if (summary === null) {
    throw new ConvertError(
      "conversion finished but reported no result — check the job log",
      "conversion-failed",
      all,
    );
  }
  if (!Number.isFinite(summary.maxAbsDiff) || summary.maxAbsDiff > maxAbsDiff) {
    throw new ConvertError(
      `converted model does not match the ONNX original (max abs diff ` +
        `${summary.maxAbsDiff}, limit ${maxAbsDiff}) — refusing to install a ` +
        "model that would score incorrectly",
      "validation-failed",
      all,
    );
  }
  return { filename: summary.file, maxAbsDiff: summary.maxAbsDiff, log: all };
}

function parseResult(
  lines: string[],
): { file: string; maxAbsDiff: number } | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const at = line.indexOf("RESULT ");
    if (at === -1) continue;
    try {
      const parsed = JSON.parse(line.slice(at + 7)) as {
        file?: unknown;
        maxAbsDiff?: unknown;
      };
      if (
        typeof parsed.file === "string" &&
        typeof parsed.maxAbsDiff === "number"
      ) {
        return { file: parsed.file, maxAbsDiff: parsed.maxAbsDiff };
      }
    } catch {
      // Keep scanning older lines.
    }
  }
  return null;
}

/**
 * Turn a job failure into something actionable. The `ONNX_IF` case is worth
 * naming explicitly: some older community models carry a conditional verifier
 * branch that onnx2tf cannot lower, and those same files are also rejected by
 * onnxruntime as invalid graphs — so it is a broken source model, not a bug in
 * the conversion.
 */
function describeFailure(lines: string[], jobError?: string): string {
  const text = lines.join("\n");
  if (/ONNX_IF|custom op|not.*implemented/i.test(text)) {
    return (
      "this ONNX model uses an operation the converter cannot translate " +
      "(often a legacy conditional 'verifier' branch found in some older " +
      "community models). Re-export it from a current training notebook, or " +
      "use a .tflite build of the same model."
    );
  }
  const failed = lines.filter((l) => /^ERROR /.test(l)).pop();
  return failed ?? jobError ?? "conversion failed — check the job log";
}
