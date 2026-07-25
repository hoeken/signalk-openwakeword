# Developing signalk-openwakeword

Technical reference for contributors and for developers integrating with
the plugin. User-facing documentation lives in [README.md](README.md).

## Code layout

| Path               | Contents                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`     | Plugin entry point: schema, start/stop, HTTP routes (`registerWithRouter`), admin guard for the update endpoints  |
| `src/config.ts`    | Settings schema, validation, and derivation of the container spec from settings (`IMAGE`, `PINNED_TAG` live here) |
| `src/service.ts`   | Container lifecycle, readiness gate, health-check loop, and `wyoming-service` discovery emission                  |
| `src/wyoming.ts`   | Embedded Wyoming `describe` client (~170 lines) — raw TCP, JSONL header framing                                   |
| `src/configpanel/` | React source for the Admin UI configuration panel (built into `public/`)                                          |
| `test/`            | Vitest suites + fixtures                                                                                          |
| `public/`          | Built config-panel bundle (webpack output, shipped in the npm package via `files`)                                |

## Commands

```sh
npm install
npm run build                 # tsc → dist/, then webpack → public/ (config panel)
npm test                      # typecheck (tsconfig.test.json) + vitest
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
its own directory. Upstream strips a `_v1.0`-style filename suffix when
deriving the model id.

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
