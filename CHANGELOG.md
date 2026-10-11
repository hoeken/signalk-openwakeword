# v0.3.0

Nothing to reconfigure — existing settings carry over unchanged.

- **New "Custom wake words" webapp.** Teaching the boat to answer to its
  own name no longer means ssh and a hand-made directory inside another
  plugin's data folder. Open it from the Webapps menu to see what is
  installed, add models by drag and drop, and delete ones you no longer
  want. It tells you the wake word name the service will actually
  advertise, and flags the two things that used to fail silently: a model
  sitting there while custom models are switched off, and a model that
  hasn't been converted yet.
- **New models work immediately.** The wake word service only looks for
  models when it starts, so a freshly added one used to stay invisible
  until someone restarted the container by hand. Adding or deleting a model
  now reloads the service for you.
- **Clear about what the boat is actually listening for.** The service
  loads every model it finds, but only the wake words you selected in the
  plugin settings are listened for. The webapp now shows that difference —
  "listening" versus "ready, not selected" — instead of calling every
  loaded model "in use".
- **ONNX models are converted for you.** The wake word service only loads
  `.tflite`, but every current training notebook produces `.onnx` — which
  is why so many trained models never worked. Drop the `.onnx` in and the
  plugin converts it on the server, then checks the result against the
  original before installing it, so a model that converted incorrectly is
  rejected instead of quietly mis-hearing you. Works on a Raspberry Pi, and
  on servers where Signal K itself runs in a container.
- **Guided wake word creation.** "Create a wake word" takes a phrase, tells
  you whether it will work well (short or everyday phrases false-trigger
  constantly), and hands you a link to the training notebook with your
  phrase already filled in — nothing to copy or paste. Training runs on a
  free Google Colab GPU, not the Signal K server, and takes roughly 75–90
  minutes on Colab Pro and about twice that on the free tier. No microphone
  is needed: the notebook generates its own training audio.
- **A training notebook that finishes.** The community notebook failed
  partway through in several ways, each costing the better part of an hour
  before it surfaced. The plugin now links to its own maintained copy with
  those fixes applied. It asks Colab for a GPU when it opens and stops in
  the first cell if it didn't get one, rather than training on a CPU for
  hours and being disconnected. The notebook link is an advanced setting,
  so it can be repointed without waiting for a plugin release.
- **Copy buttons work over plain HTTP.** Browsers only allow clipboard
  access on HTTPS, but a boat's Signal K server is usually reached over
  plain HTTP on the LAN — where the copy button did nothing. It now works
  there too, and if the browser refuses outright, it selects the text so
  you can press Ctrl+C.
- **Satellites pick up your wake word automatically.** The plugin now tells
  the signalk-wyoming orchestrator which wake words it is configured for,
  so satellites that don't set their own no longer need the same wake word
  entered a second time — previously a mismatch meant the satellite simply
  never woke, with no error. The same list is reported on `/api/status`, so
  devices that find the service over the REST API (such as ESP32
  satellites) listen for your wake word instead of falling back to
  `okay_nabu`.
- **Recommended companions.** The Appstore now suggests signalk-wyoming,
  signalk-piper, and signalk-whisper alongside this plugin, the rest of the
  voice assistant family.

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
