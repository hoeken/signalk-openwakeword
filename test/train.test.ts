import { describe, it, expect } from "vitest";
import { advisePhrase, buildTrainingPlan, slugify } from "../src/train.js";

describe("slugify", () => {
  it("makes a filesystem- and model-id-safe slug", () => {
    expect(slugify("Hey Seabird")).toBe("hey_seabird");
    expect(slugify("  ahoy!  there  ")).toBe("ahoy_there");
  });
});

describe("advisePhrase", () => {
  it("accepts a distinctive multi-syllable phrase", () => {
    const advice = advisePhrase("hey seabird");
    expect(advice).toHaveLength(1);
    expect(advice[0]?.level).toBe("ok");
  });

  it("warns about a phrase that is too short to match reliably", () => {
    const advice = advisePhrase("go");
    expect(
      advice.some((a) => a.level === "warn" && /syllable/.test(a.message)),
    ).toBe(true);
  });

  it("warns about everyday words that will false-trigger on board", () => {
    const advice = advisePhrase("stop the boat");
    expect(
      advice.some((a) => a.level === "warn" && /conversation/.test(a.message)),
    ).toBe(true);
  });

  it("warns about characters that get dropped from training audio", () => {
    const advice = advisePhrase("hey seabird!!!");
    expect(advice.some((a) => /Non-alphabetic/.test(a.message))).toBe(true);
  });
});

describe("buildTrainingPlan", () => {
  // The notebook takes two Python variables in an "EDIT THESE TWO LINES"
  // cell, NOT a YAML config — emitting YAML sent people hunting for a paste
  // target that does not exist.
  it("emits the two Python lines the notebook actually wants", () => {
    const plan = buildTrainingPlan("Hey Seabird");
    expect(plan.config).toBe(
      "TARGET_PHRASE = ['Hey Seabird']\nMODEL_NAME    = 'hey_seabird'",
    );
  });

  it("escapes an apostrophe so the Python literal stays valid", () => {
    expect(buildTrainingPlan("ahoy o'brien").config).toContain(
      "TARGET_PHRASE = ['ahoy o\\'brien']",
    );
  });

  // The notebook's first cell asks for the wake word, so the steps have to say
  // that the run pauses for it — a user who walks away misses the prompt and
  // comes back to a model trained on the example phrase.
  it("says the first cell stops and asks for the phrase", () => {
    const steps = buildTrainingPlan("hey seabird").steps.join(" ");
    expect(steps).toMatch(/first cell/i);
    expect(steps).toMatch(/asks for the wake word/i);
    expect(steps).toMatch(/hey seabird/);
  });

  // The notebook requests a GPU itself, so the steps confirm it rather than
  // sending the user to the Runtime menu.
  it("tells the user how to confirm a GPU was allocated", () => {
    const steps = buildTrainingPlan("hey seabird").steps.join(" ");
    expect(steps).toMatch(/GPU/);
    expect(steps).toMatch(/GPU present/);
  });

  // No _vN suffix: wyoming's stripping regex forbids underscores, so a
  // versioned multi-word slug would keep the suffix and the user would have to
  // type "hey_seabird_v1" as the wake word.
  it("uses a slug that wyoming will advertise verbatim", () => {
    const plan = buildTrainingPlan("hey seabird");
    expect(plan.modelId).toBe("hey_seabird");
    expect(plan.modelId).not.toMatch(/_v\d/);
  });

  // We ship our own fork because the widely-shared notebook has two
  // failures that each cost ~40 minutes before surfacing.
  it("links our maintained fork by default", () => {
    expect(buildTrainingPlan("hey seabird").notebookUrl).toContain(
      "signalk-openwakeword/blob/feat/custom-wakeword-webapp/notebooks/train_wakeword.ipynb",
    );
  });

  it("honours an overridden notebook URL", () => {
    const plan = buildTrainingPlan("hey seabird", "https://example.test/nb");
    expect(plan.notebookUrl).toBe("https://example.test/nb");
  });

  // Colab gives Python no access to the notebook tab's URL — output.eval_js
  // runs in the sandboxed output frame — so a `?phrase=` suffix would be dead
  // weight that only made the link look like it configured something.
  it("leaves the notebook link bare rather than passing the phrase in it", () => {
    const url = buildTrainingPlan("hey moin").notebookUrl;
    expect(url).not.toContain("?");
    expect(url).not.toContain("phrase");
    expect(url).not.toContain("model_name");
  });

  it("links a notebook and says the result is an .onnx file", () => {
    const plan = buildTrainingPlan("hey seabird");
    expect(plan.notebookUrl).toMatch(
      /^https:\/\/colab\.research\.google\.com\//,
    );
    expect(plan.steps.join(" ")).toMatch(/hey_seabird\.onnx/);
  });

  it("is explicit that training cannot run on the Signal K server", () => {
    const plan = buildTrainingPlan("hey seabird");
    expect(plan.steps.join(" ")).toMatch(
      /GPU|cannot run on the Signal K server/,
    );
  });

  it("carries the phrase advice through", () => {
    expect(buildTrainingPlan("go").advice.some((a) => a.level === "warn")).toBe(
      true,
    );
  });
});
