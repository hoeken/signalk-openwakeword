# Developing signalk-openwakeword

Technical reference for contributors and for developers integrating with
the plugin. User-facing documentation lives in [README.md](README.md).

## Code layout

| Path                | Contents                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`      | Plugin entry point: schema, start/stop, HTTP routes (`registerWithRouter`), admin guard for the update endpoints  |
| `src/config.ts`     | Settings schema, validation, and derivation of the container spec from settings (`IMAGE`, `PINNED_TAG` live here) |
| `src/service.ts`    | Container lifecycle, readiness gate, health-check loop, and `wyoming-service` discovery emission                  |
| `src/wyoming.ts`    | Embedded Wyoming `describe` client (~170 lines) — raw TCP, JSONL header framing                                   |
| `src/models.ts`     | Custom-model store: the `custom/` dir, model-id derivation, filename sanitization, atomic install                 |
| `src/convert.ts`    | ONNX → TFLite conversion as a one-shot container job, with numerical validation                                   |
| `src/train.ts`      | Wake-phrase advice and the pre-filled Colab training config                                                       |
| `src/api-schema.ts` | TypeBox contracts for the model/train API — imported by BOTH the routes and the webapp                            |
| `src/configpanel/`  | React source for the Admin UI configuration panel (built into `public/`)                                          |
| `src/webapp/`       | React + zustand "Custom wake words" webapp (built into `public/` by vite)                                         |
| `notebooks/`        | Forked Colab training notebook — the only component with no CI; see its section below                             |
| `test/`             | Vitest suites + fixtures                                                                                          |
| `public/`           | Built config-panel bundle **and** webapp (shipped in the npm package via `files`) — see the coexistence note      |

## Commands

```sh
npm install
npm run build                 # tsc → dist/, webpack → public/ (panel), vite → public/ (webapp)
npm test                      # typecheck (tsconfig.test.json) + vitest
npm run test:e2e              # build, then drive the webapp in headless chromium
npm run test:e2e:live         # drive a REAL server (SK_URL/SK_USER/SK_PASSWORD)
npm run test:watch            # vitest watch mode
npm run ci-lint               # eslint + prettier --check
npm run format                # prettier + eslint --fix
```

## Testing

Tests run against the scriptable `MockWyomingServer` from the
[signalk-wyoming](https://github.com/hoeken/signalk-wyoming) package's
`signalk-wyoming/mock` export and a fake `signalk-container` manager — no
docker/podman or network access needed.

`signalk-wyoming` is a **devDependency only**. Production code has no
runtime dependency on the orchestrator package: the Wyoming `describe`
handshake is the embedded client in `src/wyoming.ts`.

## Architecture notes

### Wake words are a client-side contract

`wakeWords` is deliberately **not** passed to the container. openWakeWord
loads all its bundled models and Wyoming clients select which ones to
listen for per connection via the `Detect` event. The setting exists so
that (a) the plugin can validate the operator's selection against the
model list the running service actually advertises in its `info` response
(flagging e.g. the upstream 2.0.0 `ok_nabu` → `okay_nabu` rename, where
the stale name silently matches nothing), and (b) the orchestrator can
read the boat's intended wake words from this plugin's config.

### Readiness gate

The signalk-container-helper's HTTP `readiness` option is deliberately
omitted — it is HTTP-only and a Wyoming TCP port can never satisfy it.
Readiness is our own loop: the plugin repeatedly attempts a Wyoming
`describe` handshake (`describeIntervalMs = 2_000`,
`describeTimeoutMs = 5_000`) until the service answers, with a
`gateDeadlineMs = 600_000` (10 min) deadline. Unlike whisper there is no
model download — the models ship in the image — so in practice the gate
passes as soon as the container is up. The URI is re-resolved after
container updates because the helper may move the published host port on
recreation.

### Health loop

After the gate passes, a `describe` ping runs every
`healthIntervalMs = 30_000`. `healthFailureThreshold = 3` consecutive
failures → `notifications.voice.openwakeword` at `state: "alarm"` (method
`["visual"]` only — deliberately not `sound`, so notification-to-speech
bridges don't speak the voice stack's own failure), a plugin error status,
and an `error` announcement on the discovery channel. A successful ping
resets the failure counter and clears everything back to `ready`/`normal`.

### Service discovery (`wyoming-service`)

On every status change the plugin emits a family-spec §3.1 announcement on
the shared `wyoming-service` PropertyValues channel:

```json
{
  "plugin": "signalk-openwakeword",
  "type": "wake",
  "uri": "tcp://127.0.0.1:10400",
  "status": "ready"
}
```

Emission discipline (see `StatusEmitter` in `src/service.ts`):

- **Debounce:** minimum 500 ms between emissions (`emitMinIntervalMs`);
  flaps inside the window collapse to the latest value.
- **Flap suppression:** more than `flapLimit = 10` transitions within
  `flapWindowMs = 60_000` is logged as pathological churn instead of
  emitted.
- **Cap safety:** `emitPropertyValue` is wrapped in try/catch. The
  server-wide PropertyValues cap throws for every emitter once reached, so
  on failure the emitter disables itself for the rest of the run rather
  than spamming errors.

### Custom-model mount

`advanced.customModels` sets the helper's `signalkDataMount = "/data"` and
appends `--custom-model-dir /data/custom` to the container command.
`signalkDataMount` always maps `/data` to **signalk-container's own** data
directory (`plugin-config-data/signalk-container/`, shared by every plugin
that uses it), _not_ to this plugin's `plugin-config-data/signalk-openwakeword/`
directory — the mount is provided by signalk-container, which only knows
its own directory.

`src/models.ts` is the single source of truth for that path on the host
side: it resolves the same directory via the manager's
`resolveSignalkDataMount()`, so the container's `/data/custom` and the
host's `custom/` can never drift apart. It also creates the directory,
which nothing used to do.

**Model id derivation has a sharp edge.** Upstream's regex is
`^([^_]+)_v[0-9.]+$` — `[^_]+` forbids underscores, so a version suffix is
stripped only from single-token names. `alexa_v0.1` → `alexa`, but
`hey_boat_v1` stays `hey_boat_v1` in full. `modelId()` reproduces this
exactly rather than prettifying, because the UI must show the name wyoming
will really advertise. Do not "fix" it to strip more.

### ONNX → TFLite conversion

wyoming-openwakeword 2.x globs `*.tflite` and runs it through
`libtensorflowlite_c` via ctypes; there is no ONNX code path and no config
flag that adds one. Meanwhile every maintained training notebook exports
ONNX. `src/convert.ts` bridges the two as a one-shot `runJob` container
(`pinto0309/onnx2tf`, multi-arch including arm64) so the ~1 GB toolchain is
never a plugin dependency — it is pulled the first time someone converts
something.

Two things in there are load-bearing and must not be simplified away:

1. **The pre-transpose.** onnx2tf reads a 3D input as NCW and "corrects" it
   to NWC, turning a `(1,16,96)` openWakeWord model into a `(1,96,16)`
   tflite. Nothing errors; the model just scores garbage forever. The
   documented overrides (`-k`, `-kt`, `-kat`, `-ois`) do not stop it. The
   script therefore inserts a `Transpose` at the graph input so onnx2tf's
   own swap lands back on the original layout.
2. **The numerical check.** The converted model is run against onnxruntime
   on random inputs and rejected unless the outputs match. This is what
   catches (1) if upstream ever changes behaviour, and it also catches
   unresolved custom ops — some older community models carry a legacy
   conditional `If`/verifier branch that only fails at `allocate_tensors()`.
   Those files are also rejected by onnxruntime as invalid graphs, so they
   are reported as broken sources rather than converter bugs.

Training is deliberately **not** implemented: it needs ~17 GB of
precomputed features and a CUDA GPU, so `src/train.ts` generates a
pre-filled Colab config instead of pretending a Pi can do it.

### Deployment realities (all found by running against a real server)

Four things behave differently in a containerized Signal K than any stubbed
test suggests. Each one broke the feature outright, so don't "simplify" them
away:

1. **Local path ≠ host path.** `manager.resolveSignalkDataMount()` returns the
   _host_ path — right for a bind-mount source, wrong for our own `fs` calls.
   With Signal K in a container the host path does not exist inside it, and
   every model request died with `EACCES: mkdir '/home/dirk'`. `models.ts`
   therefore derives the directory from `app.getDataDirPath()` (always local),
   while `convert.ts` translates back via `resolveHostPath()` before handing a
   mount source to the runtime.
2. **Uploads arrive as an unread stream.** Signal K registers only the `json`
   and `urlencoded` body parsers, so `application/octet-stream` never becomes
   `req.body`. `readBody()` consumes the stream itself, capped at
   `MAX_MODEL_BYTES`.
3. **The converter image runs as a non-root USER (uid 1001).** Without
   `user: { inImageUid, inImageGid }` on the job, rootless podman remaps it and
   the conversion dies with `PermissionError` on `/work`.
4. **The service only scans its model directory at startup.** A newly uploaded
   wake word is invisible until the container restarts, so installs and deletes
   call `ServiceRunner.reload()`. The route reports `reloaded` so the UI can
   distinguish "ready now" from "restart to load".

`npm run test:e2e:live` exercises all four against a running server —
uploading a real community model, converting a real ONNX one, and asserting
wyoming-openwakeword actually advertises them.

### The forked training notebook

`notebooks/train_wakeword.ipynb` is a fork of
[alfiedennen/openwakeword-colab-2026](https://github.com/alfiedennen/openwakeword-colab-2026),
which is itself a repair of dscripka's original (that one still imports the
dead `onnx_tf`). We forked because the community version has two failures on
current Colab, and both of them waste ~40 minutes before surfacing — the run
generates positive clips fine, then dies at the negatives:

| Patch        | Fixes                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| install cell | `deep-phonemizer` — provides the `dp` module openwakeword's `data.py` imports for adversarial negatives. Upstream never installs it.        |
| **G**        | torch ≥ 2.6 defaults `torch.load` to `weights_only=True` and refuses dp's checkpoint, which pickles a `Preprocessor`. Rewrites dp's loader. |
| **H**        | `add_safe_globals` allowlist as a second line of defence.                                                                                   |
| pre-flight   | Hard-fails on a CPU runtime. Upstream prints CUDA status and carries on, so "Run all" trains for hours and then disconnects.                |

Patch G is applied in **Python, not `sed`**, deliberately: the upstream patches
use `sed`, which silently no-ops if whitespace drifts, and G then asserts its
own result. That failure mode cost real time to diagnose.

**This is the one component with no CI.** A Colab notebook can only be
verified by running it — ~90 minutes of GPU time, by hand. `test/notebook.test.ts`
therefore asserts that the _reasons we forked_ are still present, so a re-sync
with upstream cannot quietly drop them. It cannot tell you the notebook still
trains; only that our fixes survived.

Fixes are offered back upstream at
[issue #1](https://github.com/alfiedennen/openwakeword-colab-2026/issues/1). If
they land, drop the fork and point `NOTEBOOK_URL` back. Users can already
override it via `advanced.notebookUrl` without waiting for a release.

### One API contract, shared by the server and the webapp

`src/api-schema.ts` defines the model/train request and response shapes once
with **TypeBox 1.x**, and both sides import it:

- the routes in `src/index.ts` validate incoming queries with `parse()`;
- the webapp store (`src/webapp/store.ts`) validates the responses it gets
  back with `Check()`, and its state types are `Static<>` derivations of the
  same schemas.

`StoredModel` in `src/models.ts` and `TrainingPlan` in `src/train.ts` are
likewise derived from those schemas rather than declared separately, so a
change to the wire format cannot silently diverge from the code on either end.

Two notes on the dependency:

- It is the **unscoped `typebox` package** (1.x), not `@sinclair/typebox`
  (the 0.x LTS line that signalk-server's `server-api` still depends on).
  They are different packages; don't mix them up when reading the docs.
- 1.x is **ESM-only** — fine here, since this package is `"type": "module"`
  and vite wants ESM for the browser bundle anyway. The value functions are
  named exports (`Check`, `Convert`, `Errors`), not the 0.x `Value.*`
  namespace, and `Errors()` yields a union in which only some members carry a
  `path`.

The webapp is typechecked by its own `tsconfig.webapp.json` (`npm run
typecheck:webapp`, part of `npm test`) because it needs DOM libs rather than
Node ones, and because the main `tsconfig.json` must not emit browser code
into `dist/`.

### public/ is shared — both builds must not clean it

Signal K serves a package's `public/` as the webapp root (see
`mountWebModules` in the server's `src/interfaces/webapps.ts`), and this
package also emits its Module Federation panel there. They coexist as plain
static files, which only works because **`output.clean: false` in
`webpack.config.cjs` and `emptyOutDir: false` in `vite.config.js`**. Flip
either to true and one build silently deletes the other's output.

Webapp assets are namespaced under `public/owwapp/` so a vite chunk can
never collide with a federation chunk. After changing either build, verify
the remote still loads:

```sh
node -e 'import("./public/remoteEntry.js").then(m => console.log(typeof m.get, typeof m.init))'
# must print: function function
```

### Config panel build

The panel is a webpack **Module Federation remote** built by
`webpack.config.cjs` (`.cjs` because the package is ESM) into `public/`,
following the Signal K `signalk-plugin-configurator` convention. It is
assembled from the shared building blocks in
[`signalk-container-helper/ui`](https://www.npmjs.com/package/signalk-container-helper).

Gotcha: because this package has `"type": "module"`, the Signal K server
injects the panel as `<script type="module">` and the Admin UI expects an
**ESM federation container** (`import()` + get/init exports). A classic
`var`-library remote loads silently into module scope and the panel dies
with "Module is not available" — hence `experiments.outputModule: true` and
`library: { type: "module" }` in the webpack config. The CommonJS reference
plugins (signalk-grafana/-questdb) do **not** need this.

The panel bundle cannot import from `src/` (it is a separate webpack
build), so its defaults and built-in wake word list mirror `src/config.ts`
— and the JSON schema in `src/config.ts` remains the fallback form for
servers without custom-panel support. **Keep all three in sync when adding
settings.**

### `GET /api/versions`

The panel's version dropdown is fed by the readonly
`GET /plugins/signalk-openwakeword/api/versions` route, which lists the
image's plain `x.y.z` Docker Hub tags, newest first. It is registered
outside the enabled-guard on purpose: the operator picks a tag while the
plugin is still disabled, and the route only reaches out to Docker Hub on
demand. When Docker Hub is unreachable it answers `502` with an
`{ error }` body (no offline cache), which the panel surfaces inline.

## Releasing

```sh
npm run release    # tags v<package.json version> and pushes the tag
```

`prepublishOnly` runs `build` + `test`, so a broken tree cannot be
published. `imageTag: auto` maps to `PINNED_TAG` in `src/config.ts`
(currently `2.1.0`) — bump it deliberately and test against the new image
before releasing.
