/**
 * Guards the forked training notebook (notebooks/train_wakeword.ipynb).
 *
 * A Colab notebook cannot be run in CI — verifying it end to end means ~90
 * minutes of GPU time by hand. What we CAN do cheaply is assert that the
 * reasons we forked it are still present, so a future re-sync with upstream
 * cannot silently drop them and send users back into a 40-minute failure.
 */

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NOTEBOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "notebooks",
  "train_wakeword.ipynb",
);

interface Cell {
  cell_type: string;
  /** nbformat allows either a string or a list of lines. */
  source: string | string[];
}

let cells: Cell[];
let text: string;

/** Normalise nbformat's two source shapes. */
const bodyOf = (c: Cell): string =>
  Array.isArray(c.source) ? c.source.join("") : c.source;

beforeAll(async () => {
  const raw = await fs.readFile(NOTEBOOK, "utf8");
  const parsed = JSON.parse(raw) as { cells: Cell[] };
  cells = parsed.cells;
  text = cells.map(bodyOf).join("\n");
});

const codeText = () =>
  cells
    .filter((c) => c.cell_type === "code")
    .map(bodyOf)
    .join("\n");

describe("forked training notebook", () => {
  it("is valid JSON with the expected cell count", () => {
    expect(cells.length).toBeGreaterThan(20);
  });

  // Fix 1: openwakeword's data.py imports dp.phonemizer for adversarial
  // negatives, but upstream never installs the package providing it.
  it("installs deep-phonemizer", () => {
    expect(codeText()).toMatch(
      /pip install[^\n]*deep-phonemizer|deep-phonemizer/,
    );
  });

  // Fix 2: torch >= 2.6 defaults torch.load to weights_only=True and refuses
  // dp's checkpoint, which pickles a Preprocessor.
  it("patches dp's torch.load for weights_only", () => {
    const code = codeText();
    expect(code).toContain("weights_only=False");
    expect(code).toContain("Patch G");
  });

  it("asserts its own patch landed rather than failing silently", () => {
    // The upstream notebook uses sed, which no-ops on any whitespace drift.
    expect(codeText()).toMatch(
      /assert .*weights_only=False|Patch G did not stick/,
    );
  });

  it("keeps the safe-globals allowlist as a second line of defence", () => {
    expect(codeText()).toContain("add_safe_globals");
  });

  // Colab now defaults to a CPU runtime; upstream prints CUDA status but
  // carries on, so "Run all" trains for hours and then disconnects.
  it("fails the pre-flight on a CPU runtime", () => {
    const code = codeText();
    expect(code).toContain("torch.cuda.is_available()");
    expect(code).toMatch(/raise RuntimeError\('CPU runtime/);
  });

  // Upstream shipped double-encoded UTF-8, so its box-drawing rules rendered
  // as "â”€â”€â”€" in the browser. Repaired in the fork; guard the repair.
  it("has no double-encoded UTF-8", () => {
    expect(text).not.toMatch(/â|Ã/);
  });

  it("reads the wake word from the URL so the webapp can pre-fill it", () => {
    const code = codeText();
    expect(code).toContain("_from_url");
    expect(code).toContain("phrase");
    expect(code).toContain("model_name");
  });

  it("stops immediately on a CPU runtime, before the long downloads", () => {
    expect(codeText()).toContain("nvidia-smi");
  });

  it("credits upstream and points at the issue we filed", () => {
    expect(text).toContain("alfiedennen/openwakeword-colab-2026");
  });

  it("still has the phrase cell users must edit", () => {
    expect(codeText()).toContain("TARGET_PHRASE");
    expect(codeText()).toContain("MODEL_NAME");
    expect(text).toContain("EDIT THESE TWO LINES");
  });

  it("still exports ONNX, which the plugin converts server-side", () => {
    expect(codeText()).toContain("onnx_export");
  });
});
