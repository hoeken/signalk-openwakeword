/**
 * Training guidance for custom wake words.
 *
 * Training is NOT run here, and that is a deliberate, permanent choice rather
 * than a missing feature: openWakeWord training needs a ~17 GB precomputed
 * feature set and a CUDA GPU, and every published trainer container requires
 * one. A "Train" button on a Raspberry Pi would be a lie.
 *
 * What this module does instead is remove the parts users actually get stuck
 * on — picking a phrase that works, and knowing what to do with the file that
 * comes back — and hand off the GPU step to Colab.
 */

import type { TrainingPlanResponse } from "./api-schema.js";

export interface PhraseAdvice {
  level: "ok" | "warn";
  message: string;
}

/**
 * Derived from the shared schema rather than declared separately, so what this
 * module builds and what the webapp consumes cannot drift apart.
 */
export type TrainingPlan = TrainingPlanResponse;

/**
 * The community-maintained 2026 trainer. Chosen over dscripka's own notebook
 * because the upstream one still imports `onnx_tf`, which is unmaintained and
 * broken on current Colab runtimes (openWakeWord issues #251/#253/#299/#331).
 * It exports ONNX, which this plugin converts on the server.
 */
export const NOTEBOOK_URL =
  "https://colab.research.google.com/github/alfiedennen/openwakeword-colab-2026/blob/main/train_wakeword.ipynb";

/** Words common enough in ordinary speech that they cause false wakes. */
const COMMON_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "of",
  "to",
  "in",
  "on",
  "at",
  "it",
  "this",
  "that",
  "yes",
  "no",
  "ok",
  "okay",
  "go",
  "stop",
  "start",
  "up",
  "down",
  "left",
  "right",
  "one",
  "two",
  "three",
  "boat",
  "water",
  "wind",
  "help",
]);

/** Rough English syllable count — good enough to flag one-syllable phrases. */
function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w === "") return 0;
  const groups = w.replace(/e$/, "").match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

export function slugify(phrase: string): string {
  return phrase
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Advice on whether a phrase will actually work as a wake word. The dominant
 * failure mode in practice is a phrase that is too short or too ordinary:
 * openWakeWord fires on acoustic similarity, so a common word triggers
 * constantly during normal conversation on board.
 */
export function advisePhrase(phrase: string): PhraseAdvice[] {
  const advice: PhraseAdvice[] = [];
  const words = phrase
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "");
  const totalSyllables = words.reduce((n, w) => n + syllables(w), 0);

  if (totalSyllables < 3) {
    advice.push({
      level: "warn",
      message:
        `"${phrase}" is only ~${totalSyllables} syllable(s). Three or more ` +
        "gives the detector far more to match on — short phrases false-trigger " +
        "constantly. Compare the built-ins: okay nabu, hey jarvis.",
    });
  }
  const common = words.filter((w) => COMMON_WORDS.has(w.toLowerCase()));
  if (common.length > 0) {
    advice.push({
      level: "warn",
      message:
        `"${common.join('", "')}" ${common.length === 1 ? "is a word" : "are words"} ` +
        "that comes up in ordinary conversation, so the model will wake when " +
        "nobody meant to call it. A distinctive or invented phrase generalizes " +
        "much better.",
    });
  }
  if (/[^a-zA-Z0-9\s'-]/.test(phrase)) {
    advice.push({
      level: "warn",
      message:
        "Non-alphabetic characters are dropped when generating the training " +
        "audio — keep the phrase to letters and spaces.",
    });
  }
  if (advice.length === 0) {
    advice.push({
      level: "ok",
      message: `"${phrase}" looks like a good wake word.`,
    });
  }
  return advice;
}

export function buildTrainingPlan(phrase: string): TrainingPlan {
  const trimmed = phrase.trim();
  const slug = slugify(trimmed);
  return {
    phrase: trimmed,
    slug,
    // No `_vN` suffix, so wyoming advertises the slug verbatim. (Its stripping
    // regex forbids underscores, so a suffix on a multi-word slug would NOT be
    // removed and the user would have to type the version too.)
    modelId: slug,
    notebookUrl: NOTEBOOK_URL,
    advice: advisePhrase(trimmed),
    config: [
      `target_phrase: ["${trimmed}"]`,
      `model_name: "${slug}"`,
      "n_samples: 5000",
      "n_samples_val: 1000",
      "steps: 10000",
      "target_accuracy: 0.7",
      "target_recall: 0.5",
    ].join("\n"),
    steps: [
      `Open the training notebook and set the phrase to "${trimmed}" ` +
        `and the model name to "${slug}".`,
      "Run the notebook. It needs a GPU runtime and takes roughly an hour — " +
        "this cannot run on the Signal K server, which has no GPU.",
      `Download the resulting ${slug}.onnx file when it finishes.`,
      "Upload it here. It is converted to the .tflite format the wake word " +
        "service requires, checked against the original for accuracy, and " +
        "installed automatically.",
    ],
  };
}
