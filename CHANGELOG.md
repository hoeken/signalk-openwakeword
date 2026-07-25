# v0.2.0

Nothing to reconfigure — existing settings carry over unchanged. The plugin
now depends on signalk-container-helper 0.2.1 or later, which is installed
automatically with the update.

- **New graphical configuration panel.** Server → Plugin Config →
  openWakeWord is now a real panel instead of the bare settings form. You
  can see at a glance whether the service and its container are running,
  check for and apply image updates with one click, and pick the service
  version from a dropdown of available releases. Wake words are now
  checkboxes driven by the models the running service actually offers
  (plus a field to add a custom one), and the panel warns you inline when
  a selected wake word doesn't exist — catching the upstream `ok_nabu` →
  `okay_nabu` rename trap — or when the service is open to the whole
  network. On servers without custom-panel support you keep the plain
  settings form, which works exactly as before.
- **Pick a version before enabling.** The version dropdown works even
  while the plugin is disabled, so you can choose the image version up
  front. If Docker Hub is unreachable — say, offshore — the panel says so
  instead of guessing; `auto` and explicit tags keep working regardless.

# v0.1.0

Initial release: openWakeWord wake word detection (Wyoming protocol) for
Signal K. Runs the `rhasspy/wyoming-openwakeword` service in a container
managed through signalk-container — the wake-word building block of the
signalk-wyoming voice-assistant family, also usable as a standalone
Wyoming wake word server (e.g. for Home Assistant or a
`wyoming-satellite`).

- **Hands-off service management.** The plugin starts a pinned, tested
  release of the service (2.1.0), keeps it running, and caps it at 384 MB
  of memory by default. With the default `imageTag: auto` you get newly
  tested releases along with plugin updates; admins can also check for and
  apply image updates on demand.
- **Fully offline.** All wake word models ship inside the ~90 MB container
  image — nothing downloads at runtime, nothing to fetch at sea.
- **Your choice of wake words.** `okay_nabu` by default; built-ins include
  `hey_jarvis`, `hey_mycroft`, `alexa`, and `hey_rhasspy`, validated
  against the running service. Sensitivity is tunable with `threshold` and
  `triggerLevel`, plus an optional `refractorySeconds` re-detection
  cooldown for double-trigger cabins.
- **Custom wake words.** Optionally load your own openWakeWord `.tflite`
  models from the shared signalk-container data directory — teach the boat
  its own name.
- **Knows when it is really ready.** The service is not reported ready
  until it actually answers a Wyoming request, and it is health-checked
  every 30 seconds afterwards. Three consecutive failures raise the
  `notifications.voice.openwakeword` alarm; recovery clears it
  automatically.
- **Plugs into the voice stack automatically.** The signalk-wyoming
  orchestrator discovers it with no configuration; standalone Wyoming
  clients can point straight at `tcp://<boat-server>:10400`.
- **LAN-reachable by default** (`bind: 0.0.0.0`) so remote satellites can
  stream audio to it, with explicit security guidance in the README; set
  `bind: 127.0.0.1` if every satellite runs on the server itself.
