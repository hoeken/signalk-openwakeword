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
 * Our fork of the community 2026 trainer (notebooks/train_wakeword.ipynb).
 *
 * dscripka's own notebook is unusable — it still imports the dead `onnx_tf`
 * (openWakeWord #251/#253/#299/#331). alfiedennen's fork fixed that, but has
 * since bit-rotted against current Colab in two more places, both of which
 * leave you with 0 negative clips ~40 minutes into a run:
 *
 *   - `deep-phonemizer` is never installed, so openwakeword's adversarial
 *     negative generator dies on `No module named 'dp'`;
 *   - torch >= 2.6 defaults `torch.load` to weights_only=True and refuses
 *     dp's checkpoint, which pickles a Preprocessor.
 *
 * We carry both fixes as Patches G and H, plus a pre-flight that fails on a
 * CPU runtime instead of silently training for hours. Offered upstream at
 * alfiedennen/openwakeword-colab-2026#1; if that lands we can point back.
 *
 * Overridable via `advanced.notebookUrl` so a future breakage is a settings
 * change rather than a plugin release.
 */
export const NOTEBOOK_REPO = "hoeken/signalk-openwakeword";
export const NOTEBOOK_REF = "main";
/**
 * Until this branch is merged upstream, `hoeken/…@main` has no notebooks/
 * directory and the link would 404. Point at the branch on the fork it is
 * actually pushed to; switch both constants back once merged.
 */
export const NOTEBOOK_SOURCE_REPO = "dirkwa/signalk-openwakeword";
export const NOTEBOOK_SOURCE_REF = "feat/custom-wakeword-webapp";
export const NOTEBOOK_URL =
  `https://colab.research.google.com/github/${NOTEBOOK_SOURCE_REPO}` +
  `/blob/${NOTEBOOK_SOURCE_REF}/notebooks/train_wakeword.ipynb`;

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

export function buildTrainingPlan(
  phrase: string,
  notebookUrl: string = NOTEBOOK_URL,
): TrainingPlan {
  const trimmed = phrase.trim();
  const slug = slugify(trimmed);
  return {
    phrase: trimmed,
    slug,
    // No `_vN` suffix, so wyoming advertises the slug verbatim. (Its stripping
    // regex forbids underscores, so a suffix on a multi-word slug would NOT be
    // removed and the user would have to type the version too.)
    modelId: slug,
    // Carry the wake word in the link. Our notebook reads these back from
    // document.location, so the phrase cell arrives pre-filled and there is
    // nothing to paste. A notebook that ignores them (an override, or an
    // older copy) still opens fine and falls back to its own defaults —
    // which is why the config block and steps below are still provided.
    notebookUrl:
      `${notebookUrl}?phrase=${encodeURIComponent(trimmed)}` +
      `&model_name=${encodeURIComponent(slug)}`,
    advice: advisePhrase(trimmed),
    // The notebook does NOT take a YAML config — it has two Python variables
    // in one cell (marked "★ EDIT THESE TWO LINES ★") that you overwrite.
    // Emit exactly those two lines so they can be pasted straight over the
    // originals. TARGET_PHRASE is a list: extra entries are pronunciation
    // variants that all train into the same wake word.
    config: [
      `TARGET_PHRASE = ['${trimmed.replace(/'/g, "\\'")}']`,
      `MODEL_NAME    = '${slug}'`,
    ].join("\n"),
    steps: [
      `Open the notebook. It arrives already set to “${trimmed}” — there is ` +
        "nothing to type in.",
      "Set Runtime → Change runtime type to a GPU. The notebook stops " +
        "immediately if you skip this, because training on a CPU runs for " +
        "hours and then gets disconnected.",
      "Choose Runtime → Run all and leave the tab open. It takes an hour or " +
        "two, and Colab wipes everything if the session drops. This cannot " +
        "run on the Signal K server, which has no graphics card.",
      `When it finishes it downloads ${slug}.onnx.`,
      "Come back here and drop that file on this page. It is converted to " +
        "the format the wake word service needs, checked against the " +
        "original, and installed for you.",
    ],
  };
}
