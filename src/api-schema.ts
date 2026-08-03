/**
 * Request/response contracts for the custom-model API, defined once with
 * TypeBox so the runtime validator and the TypeScript types cannot drift.
 *
 * Scope note: this covers the NEW model/train endpoints only. The plugin's
 * own settings deliberately stay on `withDefaults` in config.ts — that is a
 * never-rejecting coercing merge (Signal K does not seed schema defaults into
 * a plugin's saved config, and a boat should never fail to boot over a stale
 * field), which is a different contract from "validate and reject".
 *
 * Uses TypeBox 1.x — the unscoped `typebox` package, which is ESM-only and so
 * suits this package (`"type": "module"`). Two things to know when editing:
 * 1.x exports the value functions as named exports rather than the 0.x
 * `Value.*` namespace, and it is a different npm package from the 0.x LTS line
 * (`@sinclair/typebox`) that signalk-server's server-api still depends on.
 */

import { Type, type Static, type TSchema } from "typebox";
import { Check, Convert, Errors } from "typebox/value";

/** `POST /api/models` — metadata; the file itself is the raw request body. */
export const UploadQuerySchema = Type.Object({
  filename: Type.String({ minLength: 1, maxLength: 128 }),
  convert: Type.Optional(Type.Boolean()),
  overwrite: Type.Optional(Type.Boolean()),
});
export type UploadQuery = Static<typeof UploadQuerySchema>;

/** `GET /api/train/config` — the phrase the user wants to train. */
export const TrainConfigQuerySchema = Type.Object({
  phrase: Type.String({ minLength: 2, maxLength: 64 }),
});
export type TrainConfigQuery = Static<typeof TrainConfigQuerySchema>;

// ---------------------------------------------------------------------------
// Response contracts
//
// The webapp imports these too (vite resolves `typebox` for the browser
// bundle), so the shapes the server sends and the shapes the UI expects are
// one definition rather than two that drift.
// ---------------------------------------------------------------------------

/** One row of `GET /api/models`. */
export const ModelSchema = Type.Object({
  filename: Type.String(),
  /** The id wyoming actually advertises — see modelId() for the quirk. */
  id: Type.String(),
  format: Type.Union([Type.Literal("tflite"), Type.Literal("onnx")]),
  bytes: Type.Number(),
  modifiedAt: Type.String(),
  /** Present on .onnx rows: whether a .tflite sibling exists. */
  converted: Type.Optional(Type.Boolean()),
  /** The running service is advertising this model right now. */
  live: Type.Optional(Type.Boolean()),
  /** The model's id is in the plugin's configured wakeWords. */
  selected: Type.Optional(Type.Boolean()),
});
export type Model = Static<typeof ModelSchema>;

export const ModelsResponseSchema = Type.Object({
  customModelsEnabled: Type.Boolean(),
  wakeWords: Type.Array(Type.String()),
  models: Type.Array(ModelSchema),
});
export type ModelsResponse = Static<typeof ModelsResponseSchema>;

export const ConvertedSchema = Type.Object({
  filename: Type.String(),
  /** Max absolute difference from the ONNX original; 0 is a perfect match. */
  maxAbsDiff: Type.Number(),
});
export type Converted = Static<typeof ConvertedSchema>;

export const TrainingPlanSchema = Type.Object({
  phrase: Type.String(),
  slug: Type.String(),
  modelId: Type.String(),
  notebookUrl: Type.String(),
  advice: Type.Array(
    Type.Object({
      level: Type.Union([Type.Literal("ok"), Type.Literal("warn")]),
      message: Type.String(),
    }),
  ),
  config: Type.String(),
  steps: Type.Array(Type.String()),
});
export type TrainingPlanResponse = Static<typeof TrainingPlanSchema>;

export interface ValidationFailure {
  /** JSON pointer to the offending member; empty for whole-object errors. */
  path: string;
  message: string;
}

/**
 * Validate with coercion, since query strings arrive as strings and a
 * `convert=true` param must become a boolean. Returns either the typed value
 * or the list of failures, so callers never have to touch TypeBox directly.
 */
export function parse<T extends TSchema>(
  schema: T,
  input: unknown,
): { ok: true; value: Static<T> } | { ok: false; errors: ValidationFailure[] } {
  const converted = Convert(schema, input);
  if (Check(schema, converted)) {
    return { ok: true, value: converted as Static<T> };
  }
  // 1.x returns a union of error shapes and only some carry a `path` — a
  // missing-required-property error, for instance, describes the object.
  const errors = [...Errors(schema, converted)].map((e) => ({
    path: "path" in e && typeof e.path === "string" ? e.path : "",
    message: e.message,
  }));
  return { ok: false, errors };
}

/** Render failures as one line suitable for a JSON `error` field. */
export function describeErrors(errors: ValidationFailure[]): string {
  return errors
    .map((e) => `${e.path === "" ? "request" : e.path} ${e.message}`)
    .join("; ");
}
