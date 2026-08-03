/**
 * Custom wake-word model store.
 *
 * Owns the `custom/` directory that wyoming-openwakeword scans when
 * `advanced.customModels` is on. That directory lives inside the *shared*
 * signalk-container plugin data dir (see buildContainerConfig's
 * `signalkDataMount`), NOT this plugin's own — so the host path is resolved
 * through the container manager rather than app.getDataDirPath().
 *
 * Everything here is deliberately the single source of truth for that path,
 * so the container-side `/data/custom` and the host-side directory can never
 * drift apart.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  CONTAINER_PLUGIN_ID,
  CUSTOM_MODEL_DIRNAME,
  MAX_MODEL_BYTES,
  type ModelFormat,
} from "./config.js";
import type { Model } from "./api-schema.js";

/**
 * A model file on disk. Derived from the shared API schema so the store, the
 * route payload and the webapp all describe the same object.
 *
 * `id` is the name wyoming-openwakeword will actually advertise — what the
 * user must put in `wakeWords`. See modelId() for the underscore trap.
 * `converted` is set on .onnx entries when a `<id>.tflite` sibling exists.
 */
export type StoredModel = Omit<Model, "live" | "selected">;

/**
 * Reproduces wyoming-openwakeword's own id derivation
 * (`_NAME_VERSION = re.compile(r"^([^_]+)_v[0-9.]+$")` in __main__.py).
 *
 * The `[^_]+` is the trap: it forbids underscores, so only SINGLE-TOKEN names
 * get their version suffix stripped. `alexa_v0.1` → `alexa`, but
 * `hey_boat_v1` stays `hey_boat_v1` verbatim. Users reasonably expect
 * `hey_boat` and then wonder why the wake word never matches, so the UI shows
 * the id computed here rather than a prettified guess.
 */
export function modelId(filename: string): string {
  const stem = path.basename(filename).replace(/\.(tflite|onnx)$/i, "");
  const match = /^([^_]+)_v[0-9.]+$/.exec(stem);
  return match?.[1] ?? stem;
}

/** Extension → format, or null when it is not a model file at all. */
export function modelFormat(filename: string): ModelFormat | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".tflite") return "tflite";
  if (ext === ".onnx") return "onnx";
  return null;
}

export class ModelStoreError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid-name"
      | "unsupported-format"
      | "too-large"
      | "not-found"
      | "exists"
      | "dir-unavailable",
  ) {
    super(message);
    this.name = "ModelStoreError";
  }
}

/**
 * Reject anything that is not a plain filename. Uploads name their own file,
 * so this is the boundary that keeps a request from writing outside the
 * custom dir — path.basename() alone would silently *accept* "../x" by
 * rewriting it, which hides the attempt instead of reporting it.
 */
export function assertSafeFilename(filename: string): void {
  if (filename === "" || filename !== path.basename(filename)) {
    throw new ModelStoreError(
      `invalid model filename: ${JSON.stringify(filename)}`,
      "invalid-name",
    );
  }
  if (filename === "." || filename === ".." || filename.startsWith(".")) {
    throw new ModelStoreError(
      `invalid model filename: ${JSON.stringify(filename)}`,
      "invalid-name",
    );
  }
  if (modelFormat(filename) === null) {
    throw new ModelStoreError(
      `unsupported model format: ${JSON.stringify(filename)} (expected .tflite or .onnx)`,
      "unsupported-format",
    );
  }
}

/** Resolver for the shared signalk-container data dir (test seam). */
export type DataMountResolver = () => Promise<string | null>;

/** The slice of the plugin `app` object needed to locate the data dir. */
export interface DataDirApp {
  getDataDirPath?(): string;
}

/**
 * Resolve the signalk-container plugin's data directory **as this process
 * sees it**.
 *
 * The subtlety that matters: `manager.resolveSignalkDataMount()` returns the
 * *host* path, which is what podman needs as a bind source — but it is NOT
 * where this code can read and write. When Signal K itself runs in a
 * container, the host path (`/home/dirk/.signalk/...`) does not exist inside
 * it; the same directory is visible at `/home/node/.signalk/...`. Using the
 * host path here fails with EACCES/ENOENT on exactly the deployment this
 * plugin is most often used in.
 *
 * `app.getDataDirPath()` is always local and always correct, so we take this
 * plugin's own data dir and walk one level up to its sibling. Both live under
 * `<configPath>/plugin-config-data/`, and signalk-container's own directory is
 * what `signalkDataMount: "/data"` maps to — so the container's
 * `/data/custom` and the directory returned here are the same place.
 */
export function makeDataMountResolver(app: DataDirApp): DataMountResolver {
  return async () => {
    const own = app.getDataDirPath?.();
    if (own === undefined || own === "") return null;
    return path.join(path.dirname(own), CONTAINER_PLUGIN_ID);
  };
}

export class ModelStore {
  constructor(private readonly resolveDataMount: DataMountResolver) {}

  /**
   * Absolute host path of the custom-model directory, created if absent.
   *
   * Creating it is deliberate: the previous docs told users to `mkdir` it by
   * hand inside another plugin's data dir, which is the single most common
   * reason a custom model never shows up.
   */
  async dir(): Promise<string> {
    const dataMount = await this.resolveDataMount();
    if (dataMount === null || dataMount === "") {
      throw new ModelStoreError(
        "cannot resolve the signalk-container data directory — is the " +
          "signalk-container plugin installed and its runtime working?",
        "dir-unavailable",
      );
    }
    const dir = path.join(dataMount, CUSTOM_MODEL_DIRNAME);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  async list(): Promise<StoredModel[]> {
    const dir = await this.dir();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const models: StoredModel[] = [];
    const tflites = new Set(
      entries
        .filter((e) => e.isFile() && modelFormat(e.name) === "tflite")
        .map((e) => modelId(e.name)),
    );
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const format = modelFormat(entry.name);
      if (format === null) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      const id = modelId(entry.name);
      models.push({
        filename: entry.name,
        id,
        format,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        ...(format === "onnx" ? { converted: tflites.has(id) } : {}),
      });
    }
    return models.sort((a, b) => a.filename.localeCompare(b.filename));
  }

  async has(filename: string): Promise<boolean> {
    assertSafeFilename(filename);
    const dir = await this.dir();
    try {
      await fs.access(path.join(dir, filename));
      return true;
    } catch {
      return false;
    }
  }

  /** Absolute path of a model, without asserting it exists. */
  async pathOf(filename: string): Promise<string> {
    assertSafeFilename(filename);
    return path.join(await this.dir(), filename);
  }

  /**
   * Write a model atomically (temp + rename) so a wyoming rescan can never
   * observe a half-written file.
   */
  async install(
    filename: string,
    bytes: Buffer,
    options: { overwrite?: boolean } = {},
  ): Promise<StoredModel> {
    assertSafeFilename(filename);
    if (bytes.length === 0) {
      throw new ModelStoreError("model file is empty", "invalid-name");
    }
    if (bytes.length > MAX_MODEL_BYTES) {
      throw new ModelStoreError(
        `model is ${bytes.length} bytes, over the ${MAX_MODEL_BYTES}-byte limit`,
        "too-large",
      );
    }
    const dir = await this.dir();
    const target = path.join(dir, filename);
    if (options.overwrite !== true) {
      try {
        await fs.access(target);
        throw new ModelStoreError(
          `${filename} already exists — delete it first or rename the upload`,
          "exists",
        );
      } catch (err) {
        if (err instanceof ModelStoreError) throw err;
        // ENOENT is the happy path.
      }
    }
    const temp = path.join(dir, `.${filename}.${process.pid}.tmp`);
    try {
      await fs.writeFile(temp, bytes);
      await fs.rename(temp, target);
    } catch (err) {
      await fs.rm(temp, { force: true });
      throw err;
    }
    const stat = await fs.stat(target);
    const format = modelFormat(filename) as ModelFormat;
    return {
      filename,
      id: modelId(filename),
      format,
      bytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  }

  async remove(filename: string): Promise<void> {
    assertSafeFilename(filename);
    const dir = await this.dir();
    try {
      await fs.unlink(path.join(dir, filename));
    } catch {
      throw new ModelStoreError(`${filename} not found`, "not-found");
    }
  }
}
