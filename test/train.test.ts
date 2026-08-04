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

  it("tells the user which cell to edit", () => {
    expect(buildTrainingPlan("hey seabird").steps.join(" ")).toMatch(
      /EDIT THESE TWO LINES/,
    );
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
      "signalk-openwakeword/blob/main/notebooks/train_wakeword.ipynb",
    );
  });

  it("honours an overridden notebook URL", () => {
    const plan = buildTrainingPlan("hey seabird", "https://example.test/nb");
    expect(plan.notebookUrl).toBe("https://example.test/nb");
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
