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
  it("pre-fills the notebook config with the phrase and slug", () => {
    const plan = buildTrainingPlan("Hey Seabird");
    expect(plan.config).toContain('target_phrase: ["Hey Seabird"]');
    expect(plan.config).toContain('model_name: "hey_seabird"');
  });

  // No _vN suffix: wyoming's stripping regex forbids underscores, so a
  // versioned multi-word slug would keep the suffix and the user would have to
  // type "hey_seabird_v1" as the wake word.
  it("uses a slug that wyoming will advertise verbatim", () => {
    const plan = buildTrainingPlan("hey seabird");
    expect(plan.modelId).toBe("hey_seabird");
    expect(plan.modelId).not.toMatch(/_v\d/);
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
