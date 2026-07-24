# v0.1.0

Initial release. Wake word detection for Signal K boats: runs
[rhasspy/wyoming-openwakeword](https://github.com/rhasspy/wyoming-openwakeword)
as a managed container and exposes it as a Wyoming protocol service on your
network, so voice satellites (cockpit Pis, the `signalk-wyoming` local
satellite, Home Assistant, or any Wyoming client) can stream microphone audio
to it and get "wake word heard" events back. Part of the
[signalk-wyoming](https://github.com/hoeken/signalk-wyoming) voice family
alongside `signalk-whisper` (speech to text) and `signalk-piper` (text to
speech).

## Features

- **Managed container lifecycle** — pulls and runs `rhasspy/wyoming-openwakeword`
  pinned to a tested upstream release (currently `2.1.0`, overridable via
  `imageTag`), with configurable memory cap (default `384m`) and restart
  policy, via the [signalk-container](https://www.npmjs.com/package/signalk-container) plugin
- **Fully offline** — all wake word models ship inside the ~90 MB image; no
  model downloads at runtime, nothing to fetch at sea
- **Wake word configuration** — `wakeWords` (default `okay_nabu`; built-ins
  include `hey_jarvis`, `hey_mycroft`, `alexa`, `hey_rhasspy`) validated
  against the running service, plus `threshold` and `triggerLevel` sensitivity
  tuning and an optional `refractorySeconds` re-detection cooldown
- **Custom wake words** — optionally mount the shared signalk-container data
  directory and load your own openWakeWord `.tflite` models via
  `--custom-model-dir`
- **Protocol-native health checks** — the plugin reports `ready` only once the
  service answers a Wyoming `describe` request; a periodic health loop raises
  the `notifications.voice.openwakeword` alarm after three consecutive
  failures and clears it on recovery
- **Discovery and integration** — advertises itself via the `wyoming-service`
  PropertyValues convention so the `signalk-wyoming` orchestrator finds it
  automatically; standalone Wyoming clients can point straight at
  `tcp://<boat-server>:10400`
- **Status and update API** — `GET /api/status` for state introspection, and
  `GET /api/update/check` / `POST /api/update/apply` (admin) for container
  image updates
- **LAN-reachable by default** (`bind: 0.0.0.0`) so remote satellites can
  stream audio to it, with explicit security guidance in the README; set
  `bind: 127.0.0.1` if every satellite runs on the server itself

## Requirements

- Signal K server ≥ 2.x on Node.js ≥ 24
- The signalk-container plugin with a working podman or docker runtime
- ~384 MB RAM headroom for the container
- amd64 or arm64 (no armv7 — upstream stopped publishing it)
