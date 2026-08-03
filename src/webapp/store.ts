/**
 * Webapp state.
 *
 * zustand rather than useState because the model list, the upload/conversion
 * queue and the training wizard all read and mutate the same data from sibling
 * components — the config panel's flat useState form does not have that
 * problem and deliberately keeps using useState.
 *
 * Server responses are validated against the SAME TypeBox schemas the routes
 * use (`src/api-schema.ts`), so the client and server share one definition
 * instead of two that drift. TypeBox 1.x is ESM-only, which is exactly what
 * vite wants for the browser bundle.
 */

import { create } from "zustand";
import { Check } from "typebox/value";
import {
  ConvertedSchema,
  ModelsResponseSchema,
  TrainingPlanSchema,
  type Converted,
  type Model,
  type ModelsResponse,
  type TrainingPlanResponse,
} from "../api-schema.js";

const BASE = "/plugins/signalk-openwakeword";

export interface Notice {
  kind: "error" | "info" | "success" | "warn";
  text: string;
  detail?: string;
}

interface ErrorBody {
  error?: string;
  code?: string;
  log?: string[];
}

async function readErrorBody(response: Response): Promise<ErrorBody> {
  try {
    return (await response.json()) as ErrorBody;
  } catch {
    return {};
  }
}

/** Last few converter log lines — the useful part when a conversion fails. */
function logTail(body: ErrorBody): string | undefined {
  return Array.isArray(body.log) ? body.log.slice(-6).join("\n") : undefined;
}

export interface StoreState {
  models: Model[];
  wakeWords: string[];
  customModelsEnabled: boolean;
  loading: boolean;
  notice: Notice | null;
  /** Filename currently uploading/converting, or null. */
  busyWith: string | null;
  setNotice: (notice: Notice | null) => void;
  dismissNotice: () => void;
  refresh: () => Promise<void>;
  upload: (file: File, options?: { overwrite?: boolean }) => Promise<boolean>;
  convert: (filename: string) => Promise<void>;
  remove: (filename: string) => Promise<void>;
  trainingPlan: (phrase: string) => Promise<TrainingPlanResponse>;
}

export const useStore = create<StoreState>((set, get) => ({
  models: [],
  wakeWords: [],
  customModelsEnabled: false,
  loading: true,
  notice: null,
  busyWith: null,

  setNotice: (notice) => set({ notice }),
  dismissNotice: () => set({ notice: null }),

  async refresh() {
    try {
      const response = await fetch(`${BASE}/api/models`);
      if (!response.ok) {
        const body = await readErrorBody(response);
        set({
          loading: false,
          notice: {
            kind: "error",
            text:
              body.error ?? `Could not list models (HTTP ${response.status})`,
          },
        });
        return;
      }
      const body: unknown = await response.json();
      if (!Check(ModelsResponseSchema, body)) {
        set({
          loading: false,
          notice: {
            kind: "error",
            text: "The server sent a model list this version doesn't understand.",
            detail: "Check that the plugin and this page are the same version.",
          },
        });
        return;
      }
      const parsed = body as ModelsResponse;
      set({
        models: parsed.models,
        wakeWords: parsed.wakeWords,
        customModelsEnabled: parsed.customModelsEnabled,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, notice: { kind: "error", text: String(err) } });
    }
  },

  /**
   * Upload a File. ONNX uploads are converted server-side; that is the whole
   * point — the maintained training notebooks emit ONNX, but the wake word
   * service only ever loads .tflite.
   */
  async upload(file, { overwrite = false } = {}) {
    const isOnnx = /\.onnx$/i.test(file.name);
    set({
      busyWith: file.name,
      notice: {
        kind: "info",
        text: isOnnx
          ? `Uploading ${file.name} and converting it to TFLite…`
          : `Uploading ${file.name}…`,
        ...(isOnnx
          ? {
              detail:
                "Conversion runs on the server and takes a moment. The first " +
                "one also downloads the converter, which is larger.",
            }
          : {}),
      },
    });
    try {
      const params = new URLSearchParams({
        filename: file.name,
        convert: String(isOnnx),
        overwrite: String(overwrite),
      });
      const response = await fetch(`${BASE}/api/models?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (!response.ok) {
        const body = await readErrorBody(response);
        set({
          busyWith: null,
          notice: {
            kind: "error",
            text: body.error ?? `Upload failed (HTTP ${response.status})`,
            ...(body.code === "exists"
              ? { detail: "A model with that name is already installed." }
              : (() => {
                  const tail = logTail(body);
                  return tail === undefined ? {} : { detail: tail };
                })()),
          },
        });
        return false;
      }
      const body = (await response.json()) as { converted?: unknown };
      await get().refresh();
      const converted = Check(ConvertedSchema, body.converted)
        ? (body.converted as Converted)
        : null;
      set({
        busyWith: null,
        notice: {
          kind: "success",
          text:
            converted === null
              ? `Installed ${file.name}.`
              : `Installed ${converted.filename}.`,
          ...(converted === null
            ? {}
            : {
                detail:
                  "Converted from ONNX and verified against the original " +
                  `(difference ${converted.maxAbsDiff.toExponential(1)}).`,
              }),
        },
      });
      return true;
    } catch (err) {
      set({ busyWith: null, notice: { kind: "error", text: String(err) } });
      return false;
    }
  },

  async convert(filename) {
    set({
      busyWith: filename,
      notice: { kind: "info", text: `Converting ${filename} to TFLite…` },
    });
    try {
      const response = await fetch(
        `${BASE}/api/models/${encodeURIComponent(filename)}/convert`,
        { method: "POST" },
      );
      const body = await readErrorBody(response);
      if (!response.ok) {
        const tail = logTail(body);
        set({
          busyWith: null,
          notice: {
            kind: "error",
            text: body.error ?? `Conversion failed (HTTP ${response.status})`,
            ...(tail === undefined ? {} : { detail: tail }),
          },
        });
        return;
      }
      const converted = (body as { converted?: unknown }).converted;
      await get().refresh();
      if (!Check(ConvertedSchema, converted)) {
        set({
          busyWith: null,
          notice: { kind: "success", text: `Converted ${filename}.` },
        });
        return;
      }
      const ok = converted as Converted;
      set({
        busyWith: null,
        notice: {
          kind: "success",
          text: `Converted to ${ok.filename}.`,
          detail:
            "Verified against the original " +
            `(difference ${ok.maxAbsDiff.toExponential(1)}).`,
        },
      });
    } catch (err) {
      set({ busyWith: null, notice: { kind: "error", text: String(err) } });
    }
  },

  async remove(filename) {
    try {
      const response = await fetch(
        `${BASE}/api/models/${encodeURIComponent(filename)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        const body = await readErrorBody(response);
        set({
          notice: {
            kind: "error",
            text: body.error ?? `Could not delete ${filename}`,
          },
        });
        return;
      }
      await get().refresh();
      set({ notice: { kind: "success", text: `Deleted ${filename}.` } });
    } catch (err) {
      set({ notice: { kind: "error", text: String(err) } });
    }
  },

  async trainingPlan(phrase) {
    const response = await fetch(
      `${BASE}/api/train/config?phrase=${encodeURIComponent(phrase)}`,
    );
    if (!response.ok) {
      const body = await readErrorBody(response);
      throw new Error(body.error ?? "Could not build a training plan");
    }
    const body: unknown = await response.json();
    if (!Check(TrainingPlanSchema, body)) {
      throw new Error("The server sent an unexpected training plan.");
    }
    return body as TrainingPlanResponse;
  },
}));

export { BASE };
