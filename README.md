# signalk-openwakeword

> **Status: ALPHA.** This SignalK Wyoming system is 100% vibecoded slop. I
> don't have the right hardware yet to test it, so I'm putting it out there
> for people to test in the meantime. It _should_ work. File issues for
> anything that doesn't.

## What is this?

Wake word detection for [Signal K](https://signalk.org) — the part of a
voice assistant that listens for "okay nabu" (or "hey jarvis", "alexa", …)
so the rest of the stack knows when to start paying attention. The plugin
runs [openWakeWord](https://github.com/rhasspy/wyoming-openwakeword) as a
background service and takes care of everything around it: starting it in a
container (via the
[signalk-container](https://www.npmjs.com/package/signalk-container)
plugin), checking that it stays healthy, and telling the rest of the voice
stack where to find it. You never have to touch docker or podman yourself.

It is the wake-word building block of the
[signalk-wyoming voice-assistant family](https://github.com/hoeken/signalk-wyoming)
— install it together with the `signalk-wyoming` orchestrator,
`signalk-whisper` (speech to text), and `signalk-piper` (text to speech) to
get voice commands on your boat. Because it speaks the standard
[Wyoming protocol](https://github.com/rhasspy/wyoming), it also works as a
standalone wake word server for other software such as Home Assistant.

**Fully offline:** all wake word models ship inside the container image.
First start pulls the ~90 MB image and nothing else — no model downloads,
no surprises at sea.

## Requirements

- Signal K server ≥ 2.x on **Node 24+**
- The **signalk-container** plugin with a working podman or docker runtime
- ~384 MB RAM headroom for the container (the default memory cap)
- amd64 or arm64 (no armv7 — upstream stopped publishing it)

## Install

Install **signalk-openwakeword** from the Signal K App Store (or
`npm install signalk-openwakeword` in your server directory), enable it in
Plugin Config, and enable the signalk-container plugin if you have not
already. The plugin pulls and starts a pinned, tested release of the
service and reports `ready` once the detector actually answers — not just
once the container is up.

## Configuration

The plugin ships a graphical configuration panel (Server → Plugin Config →
openWakeWord) with a live container status card, a one-click image update
check/apply, a version dropdown fed by Docker Hub, wake word checkboxes
driven by the models the running service actually advertises, and all the
settings below — with inline warnings when a selected wake word is missing
or the service is open to the network. On servers without custom-panel
support you get a plain settings form with the same options.

| Setting                      | Default          | Notes                                                                                                                                     |
| ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `wakeWords`                  | `["okay_nabu"]`  | Wake words your satellites use. See [Wake words & sensitivity](#wake-words--sensitivity).                                                 |
| `threshold`                  | `0.5`            | Wake probability threshold (0–1). Lower = more sensitive, more false wakes.                                                               |
| `triggerLevel`               | `1`              | Activations above the threshold before a detection fires. Raise it in noisy cabins.                                                       |
| `port`                       | `10400`          | Host TCP port the Wyoming service is published on.                                                                                        |
| `bind`                       | `0.0.0.0`        | Host interface for the published port. See [Security](#security).                                                                         |
| `imageTag`                   | `auto`           | `auto` runs the pinned, tested upstream release (**2.1.0**) and follows plugin updates. Set an explicit Docker tag to pin something else. |
| `memoryLimit`                | `384m`           | Container memory cap (swap disabled).                                                                                                     |
| `restartPolicy`              | `unless-stopped` | Container restart policy.                                                                                                                 |
| `advanced.refractorySeconds` | _(unset)_        | Minimum seconds between re-detections (upstream default 2.0).                                                                             |
| `advanced.customModels`      | `false`          | Load your own model files. See [Custom wake words](#custom-wake-words).                                                                   |
| `advanced.advertiseHost`     | _(unset)_        | Overrides the host part of the advertised `tcp://` URI (containerized Signal K, multi-NIC hosts).                                         |

### Wake words & sensitivity

The built-in wake words are `okay_nabu` (default), `hey_jarvis`,
`hey_mycroft`, `alexa`, and `hey_rhasspy`. The `wakeWords` list is what
your satellites will listen for — it is validated against the running
service and shared with the `signalk-wyoming` orchestrator, and the config
panel warns you if a selected word is not available (note: upstream 2.0.0
renamed `ok_nabu` to `okay_nabu`; the old name silently matches nothing).

Tuning for your boat:

- **Missing wakes** (it doesn't hear you): lower `threshold` a little, e.g.
  `0.4`.
- **False wakes** (it triggers on engine noise or conversation): raise
  `threshold`, or raise `triggerLevel` to `2`–`3` so a single borderline
  hit isn't enough.
- **Double triggers** from one utterance: set
  `advanced.refractorySeconds` (upstream default is 2 seconds between
  re-detections).

## Custom wake words

Want your boat to answer to its own name? Enable
`advanced.customModels`, then drop openWakeWord `.tflite` model files into
the `custom/` folder inside the **signalk-container** plugin's data
directory (`<signalk>/plugin-config-data/signalk-container/custom/` —
create `custom/` if it doesn't exist; note this is signalk-container's
directory, shared by all plugins that use it, not this plugin's own) and
restart the plugin. If Signal K itself runs in a container with a
volume-backed data directory, put the files in the corresponding location
inside that volume. A `_v1.0`-style filename suffix is stripped for the
model id. A webapp upload UI is planned for v1.x; the manual drop works
today.

## Using it from other software

Once ready, the service is a plain Wyoming wake word server at
`tcp://<boat-server>:10400`:

- **signalk-wyoming** discovers it automatically — nothing to configure.
- **Remote satellites** (cockpit Pis running `wyoming-satellite`) point at
  it with `--wake-uri tcp://<boat-server>:10400 --wake-word-name okay_nabu`.
- **Home Assistant** (or any other Wyoming client) can use it via the
  Wyoming integration at the same URI — no Signal K required on the client
  side.

## HTTP API

| Endpoint                                              | Access                 | Purpose                                                                                        |
| ----------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /plugins/signalk-openwakeword/api/status`        | any authenticated user | Current state: `{ status, uri, tag, containerState, lastHealth, info }`                        |
| `GET /plugins/signalk-openwakeword/api/versions`      | any authenticated user | Available image versions from Docker Hub (feeds the config panel; works while plugin disabled) |
| `GET /plugins/signalk-openwakeword/api/update/check`  | admin                  | Check whether a newer image is available                                                       |
| `POST /plugins/signalk-openwakeword/api/update/apply` | admin                  | Pull and switch to the newer image                                                             |

## Health & notifications

The plugin checks the service every 30 seconds. If it stops answering,
after three consecutive failures (about 90 seconds) it raises the Signal K
notification **`notifications.voice.openwakeword`** with `state: "alarm"`
and shows an error in Plugin Config. When the service answers again
everything clears back to normal automatically — no action needed.

The alarm is visual-only by design: plugins that read notifications aloud
won't try to _speak_ the voice stack's own failure.

## Security

Wyoming has **no authentication.** Unlike whisper/piper (loopback-only by
default), the wake word service must be reachable from your LAN so remote
satellites can stream audio to it — that is why `bind` defaults to
`0.0.0.0`. The exposure is modest (openWakeWord only ever sees audio a
client chooses to send it, and only ever answers with detections), but the
_satellites_ on the same network are open live microphones — treat every
satellite port like a baby monitor. On marina wifi, put the boat network
behind a firewall or VLAN, or use WireGuard between boat segments. If every
satellite runs on the server itself, set `bind` to `127.0.0.1`.

## Development

See [DEVELOPERS.md](DEVELOPERS.md) for the code layout, build/test
commands, architecture notes, and the service-discovery contract.

## License

Apache-2.0 © hoeken. The container image it runs is
[rhasspy/wyoming-openwakeword](https://github.com/rhasspy/wyoming-openwakeword)
(MIT).
