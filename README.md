# signalk-openwakeword

Wake word detection for Signal K boats. This plugin runs
[rhasspy/wyoming-openwakeword](https://github.com/rhasspy/wyoming-openwakeword)
as a managed container and exposes it as a [Wyoming
protocol](https://github.com/rhasspy/wyoming) service on your network, so
voice satellites (cockpit Pis, the `signalk-wyoming` local satellite, or any
Wyoming client such as Home Assistant) can stream microphone audio to it and
get "wake word heard" events back. It is one of the
[signalk-wyoming](https://github.com/hoeken/signalk-wyoming) voice family:
`signalk-wyoming` (orchestrator + webapp), `signalk-whisper` (speech to
text), `signalk-piper` (text to speech), and this plugin (wake words).

**Fully offline:** all wake word models ship inside the container image.
First start pulls the ~90 MB image and nothing else — no model downloads, no
surprises at sea.

## Requirements

- Signal K server ≥ 2.x on Node.js ≥ 24
- The [signalk-container](https://www.npmjs.com/package/signalk-container)
  plugin with a working podman or docker runtime
- ~384 MB RAM headroom for the container (the default memory cap)
- amd64 or arm64 (no armv7 — upstream stopped publishing it)

## Install

Install **signalk-openwakeword** from the Signal K App Store (plus
signalk-container if you don't have it), enable it in Plugin Config, and the
plugin pulls and starts `rhasspy/wyoming-openwakeword` pinned to a tested
release. The plugin reports `ready` only once the service answers a Wyoming
`describe` request — proof the detector is actually up, not just the
container.

## Configuration

| Setting                      | Default          | Notes                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeWords`                  | `["okay_nabu"]`  | Wake words your satellites use. Built-ins: `okay_nabu`, `hey_jarvis`, `hey_mycroft`, `alexa`, `hey_rhasspy`. **Not** passed to the container — Wyoming clients select models per connection (`Detect` event); this list is validated against the running service and shared with the orchestrator. ⚠️ upstream 2.0.0 renamed `ok_nabu` → `okay_nabu`; the old name silently matches nothing. |
| `threshold`                  | `0.5`            | Wake probability threshold (0–1). Lower = more sensitive, more false wakes.                                                                                                                                                                                                                                                                                                                  |
| `triggerLevel`               | `1`              | Activations above the threshold before a detection fires. Raise it in noisy cabins.                                                                                                                                                                                                                                                                                                          |
| `port`                       | `10400`          | Host TCP port the Wyoming service is published on.                                                                                                                                                                                                                                                                                                                                           |
| `bind`                       | `0.0.0.0`        | Host interface for the published port. See [Security](#security).                                                                                                                                                                                                                                                                                                                            |
| `imageTag`                   | `auto`           | `auto` pins the tested upstream release (currently `2.1.0`); set an explicit Docker tag to override.                                                                                                                                                                                                                                                                                         |
| `memoryLimit`                | `384m`           | Container memory cap (swap disabled).                                                                                                                                                                                                                                                                                                                                                        |
| `restartPolicy`              | `unless-stopped` | Container restart policy.                                                                                                                                                                                                                                                                                                                                                                    |
| `advanced.refractorySeconds` | _(unset)_        | `--refractory-seconds` — minimum seconds between re-detections (upstream default 2.0).                                                                                                                                                                                                                                                                                                       |
| `advanced.customModels`      | `false`          | Mounts the shared signalk-container data directory at `/data` and passes `--custom-model-dir /data/custom`. See [Custom wake words](#custom-wake-words).                                                                                                                                                                                                                                     |
| `advanced.advertiseHost`     | _(unset)_        | Overrides the host part of the advertised `tcp://` URI (containerized Signal K, multi-NIC hosts).                                                                                                                                                                                                                                                                                            |

## Using it from other software

The service speaks plain Wyoming over TCP at `tcp://<boat-server>:10400`.
The `signalk-wyoming` orchestrator discovers it automatically via the
`wyoming-service` PropertyValues convention:

```js
{ plugin: 'signalk-openwakeword', type: 'wake', uri: 'tcp://127.0.0.1:10400', status: 'ready' }
```

Standalone use works too: point Home Assistant's Wyoming integration, a
`wyoming-satellite` (`--wake-uri tcp://<boat-server>:10400
--wake-word-name okay_nabu`), or any other Wyoming client at the URI — no
Signal K required on the client side.

## Health & notifications

- Readiness and liveness are protocol-native: a periodic Wyoming `describe`
  ping must return a valid `info` response. Three consecutive failures set a
  plugin error, emit `wyoming-service` status `error`, and raise the
  `notifications.voice.openwakeword` notification with `state: 'alarm'`
  (method `['visual']` — deliberately not `'sound'`, so notification-to-speech
  bridges don't narrate voice-stack outages). Recovery clears it back to
  `normal`.
- Plugin status shows what's happening at each stage (image pull, waiting
  for the service, running).
- `GET /plugins/signalk-openwakeword/api/status` returns
  `{ status, uri, tag, containerState, lastHealth, info }` (readonly access).
  `GET /api/update/check` / `POST /api/update/apply` (admin) manage container
  image updates.

## Security

**Wyoming has no authentication.** Unlike whisper/piper (loopback-only by
default), the wake word service must be reachable from your LAN so remote
satellites can stream audio to it — that is why `bind` defaults to
`0.0.0.0`. The exposure is modest (openWakeWord only ever sees audio a
client chooses to send it, and only ever answers with detections), but the
_satellites_ on the same network are open live microphones — treat every
satellite port like a baby monitor. On marina wifi, put the boat network
behind a firewall or VLAN, or use WireGuard between boat segments. If every
satellite runs on the server itself, set `bind` to `127.0.0.1`.

## Custom wake words

Enable `advanced.customModels`, then drop openWakeWord `.tflite` model files
into the `custom/` folder inside the **signalk-container** plugin's data
directory (`<signalk>/plugin-config-data/signalk-container/custom/` — create
`custom/` if it doesn't exist) and restart the plugin. The mount is provided
by signalk-container's `signalkDataMount`, which always maps `/data` to
signalk-container's _own_ data directory (shared by every plugin that uses
it), **not** to this plugin's `plugin-config-data/signalk-openwakeword/`
directory. If Signal K itself runs in a container with a volume-backed data
directory, put the files in the corresponding location inside that volume.
The container loads them via `--custom-model-dir /data/custom`; a `_v1.0`
style filename suffix is stripped for the model id. A webapp upload UI is
planned for v1.x; the manual drop works today.

## Development

```bash
npm install --install-links   # copies the sibling signalk-wyoming for its test mock
npm run build                 # tsc → dist/
npm test                      # typecheck + vitest (mock Wyoming server, fake container manager)
npm run ci-lint               # eslint + prettier --check
```

Tests never touch docker: the container manager is faked and the Wyoming
endpoint is the scriptable `signalk-wyoming/mock` server. `signalk-wyoming`
is a `file:../signalk-wyoming` devDependency until its first npm release,
after which it flips to a semver range. Production code has no runtime
dependency on it — the plugin embeds its own ~150-line `describe` client.

## License

Apache-2.0 © hoeken. The container image it runs is
[rhasspy/wyoming-openwakeword](https://github.com/rhasspy/wyoming-openwakeword)
(MIT).
