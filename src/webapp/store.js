/**
 * Webapp state. zustand rather than useState because the model list, the
 * upload/conversion queue and the training wizard all read and mutate the same
 * data from sibling components — the config panel's flat useState form does
 * not have that problem and deliberately keeps using useState.
 */

import { create } from "zustand";

const BASE = "/plugins/signalk-openwakeword";

async function readError(response, fallback) {
  try {
    const body = await response.json();
    return body?.error || fallback;
  } catch {
    return fallback;
  }
}

export const useStore = create((set, get) => ({
  models: [],
  wakeWords: [],
  customModelsEnabled: false,
  loading: true,
  /** null | {kind: 'error'|'info'|'success', text, detail?} */
  notice: null,
  /** Filename currently uploading/converting, or null. */
  busyWith: null,

  setNotice: (notice) => set({ notice }),
  dismissNotice: () => set({ notice: null }),

  async refresh() {
    try {
      const response = await fetch(`${BASE}/api/models`);
      if (!response.ok) {
        set({
          loading: false,
          notice: {
            kind: "error",
            text: await readError(
              response,
              `Could not list models (HTTP ${response.status})`,
            ),
          },
        });
        return;
      }
      const body = await response.json();
      set({
        models: body.models || [],
        wakeWords: body.wakeWords || [],
        customModelsEnabled: body.customModelsEnabled === true,
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
        detail: isOnnx
          ? "Conversion runs on the server and takes a moment. The first one " +
            "also downloads the converter, which is larger."
          : undefined,
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
        const body = await response.json().catch(() => ({}));
        set({
          busyWith: null,
          notice: {
            kind: "error",
            text: body.error || `Upload failed (HTTP ${response.status})`,
            detail:
              body.code === "exists"
                ? "A model with that name is already installed."
                : Array.isArray(body.log)
                  ? body.log.slice(-6).join("\n")
                  : undefined,
          },
        });
        return false;
      }
      const body = await response.json();
      await get().refresh();
      const converted = body.converted;
      set({
        busyWith: null,
        notice: {
          kind: "success",
          text: converted
            ? `Installed ${converted.filename}.`
            : `Installed ${file.name}.`,
          detail: converted
            ? `Converted from ONNX and verified against the original ` +
              `(difference ${converted.maxAbsDiff.toExponential(1)}).`
            : undefined,
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
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        set({
          busyWith: null,
          notice: {
            kind: "error",
            text: body.error || `Conversion failed (HTTP ${response.status})`,
            detail: Array.isArray(body.log)
              ? body.log.slice(-6).join("\n")
              : undefined,
          },
        });
        return;
      }
      await get().refresh();
      set({
        busyWith: null,
        notice: {
          kind: "success",
          text: `Converted to ${body.converted.filename}.`,
          detail: `Verified against the original (difference ${body.converted.maxAbsDiff.toExponential(1)}).`,
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
        set({
          notice: {
            kind: "error",
            text: await readError(response, `Could not delete ${filename}`),
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
      throw new Error(
        await readError(response, "Could not build a training plan"),
      );
    }
    return response.json();
  },
}));

export { BASE };
