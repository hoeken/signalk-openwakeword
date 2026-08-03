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
 * Pinned to TypeBox 0.34.x — the current `latest`; there is no 1.0 release.
 */

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

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

export interface ValidationFailure {
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
  const converted = Value.Convert(schema, input);
  if (Value.Check(schema, converted)) {
    return { ok: true, value: converted as Static<T> };
  }
  const errors = [...Value.Errors(schema, converted)].map((e) => ({
    path: e.path,
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
