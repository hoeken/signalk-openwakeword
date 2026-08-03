/**
 * Custom plugin-config panel for the Signal K Admin UI, built on the shared
 * signalk-container-helper/ui building blocks. Replaces the JSON-schema
 * auto-form (which remains the fallback on servers without panel support):
 * live container status card, image update check/apply, a Docker Hub
 * version dropdown fed by /api/versions, wake word checkboxes driven by the
 * running service's advertised models, and the detection/port/advanced
 * settings with inline missing-model and 0.0.0.0-bind notes.
 *
 * Loaded as a webpack Module Federation remote; `react` resolves to the
 * Admin UI's shared singleton. The defaults and the wake-model helper
 * mirror ../config.ts and ../wyoming.ts — the panel bundle cannot import
 * the Node-only server code.
 */

import React, { useState } from "react";
import {
  panelStyles as S,
  stateColors,
  SectionTitle,
  StatusCard,
  FieldRow,
  VersionSelect,
  UpdateControls,
  CollapsibleSection,
  ActionStatus,
  Button,
  useStatusPoll,
  useVersions,
} from "signalk-container-helper/ui";

const BASE = "/plugins/signalk-openwakeword";
const IMAGE = "rhasspy/wyoming-openwakeword";
const DEFAULT_PORT = 10400;

/** Mirrors DEFAULT_SETTINGS in ../config.ts. */
const DEFAULTS = {
  imageTag: "auto",
  bind: "0.0.0.0",
  wakeWords: ["okay_nabu"],
  threshold: 0.5,
  triggerLevel: 1,
  memoryLimit: "384m",
  restartPolicy: "unless-stopped",
};

/** Mirrors BUILTIN_WAKE_WORDS in ../config.ts (2.0.0: ok_nabu → okay_nabu). */
const BUILTIN_WAKE_WORDS = [
  "okay_nabu",
  "hey_jarvis",
  "hey_mycroft",
  "alexa",
  "hey_rhasspy",
];

/** Mirrors wakeModelNames in ../wyoming.ts (info.wake[].models[].name). */
function wakeModelNames(info) {
  const names = [];
  if (!info || !Array.isArray(info.wake)) return names;
  for (const program of info.wake) {
    if (!program || !Array.isArray(program.models)) continue;
    for (const model of program.models) {
      if (model && typeof model.name === "string" && model.name !== "") {
        names.push(model.name);
      }
    }
  }
  return names;
}

export default function PluginConfigurationPanel({ configuration, save }) {
  const cfg = configuration || {};
  const adv = cfg.advanced || {};

  const [wakeWords, setWakeWords] = useState(() => {
    const words = Array.isArray(cfg.wakeWords)
      ? cfg.wakeWords.filter((w) => typeof w === "string" && w !== "")
      : [];
    return words.length > 0 ? words : [...DEFAULTS.wakeWords];
  });
  const [customWord, setCustomWord] = useState("");
  const [threshold, setThreshold] = useState(
    String(
      typeof cfg.threshold === "number" ? cfg.threshold : DEFAULTS.threshold,
    ),
  );
  const [triggerLevel, setTriggerLevel] = useState(
    String(
      typeof cfg.triggerLevel === "number"
        ? cfg.triggerLevel
        : DEFAULTS.triggerLevel,
    ),
  );
  const [port, setPort] = useState(String(cfg.port ?? DEFAULT_PORT));
  const [bind, setBind] = useState(
    cfg.bind === "127.0.0.1" ? "127.0.0.1" : DEFAULTS.bind,
  );
  const [imageTag, setImageTag] = useState(cfg.imageTag || DEFAULTS.imageTag);
  const [memoryLimit, setMemoryLimit] = useState(
    cfg.memoryLimit || DEFAULTS.memoryLimit,
  );
  const [restartPolicy, setRestartPolicy] = useState(
    cfg.restartPolicy || DEFAULTS.restartPolicy,
  );
  const [refractorySeconds, setRefractorySeconds] = useState(
    typeof adv.refractorySeconds === "number"
      ? String(adv.refractorySeconds)
      : "",
  );
  const [customModels, setCustomModels] = useState(adv.customModels === true);
  const [advertiseHost, setAdvertiseHost] = useState(
    typeof adv.advertiseHost === "string" ? adv.advertiseHost : "",
  );
  const [saved, setSaved] = useState("");

  const { status, loading, refresh } = useStatusPoll(`${BASE}/api/status`, {
    fallback: { status: "not_running" },
  });
  const versions = useVersions(`${BASE}/api/versions`);

  // /api/status answers 503 { error } while the plugin is disabled, so a
  // missing status field means "not running", not a broken poll.
  const st =
    status && typeof status.status === "string" ? status.status : "not_running";
  const state = st === "ready" ? "ok" : st === "starting" ? "warn" : "error";
  const advertised = wakeModelNames(status && status.info);
  const meta = loading
    ? "Checking..."
    : st === "ready"
      ? `${IMAGE}:${status.tag} at ${status.uri}` +
        (advertised.length > 0
          ? ` — ${advertised.length} wake word model${advertised.length === 1 ? "" : "s"}`
          : "")
      : st === "starting"
        ? "Starting — wake word models ship in the image, nothing to download"
        : st === "error"
          ? `Not answering${status && status.uri ? ` at ${status.uri}` : ""}`
          : "Not running";

  // Checkbox list: what the running service advertises (built-ins while it
  // is down), always including the current selection so saved words never
  // silently disappear from the form — the checkbox analogue of the
  // "controlled select must always render its value" convention.
  const knownWords = advertised.length > 0 ? advertised : BUILTIN_WAKE_WORDS;
  const listedWords = [
    ...knownWords,
    ...wakeWords.filter((w) => !knownWords.includes(w)),
  ];
  const missing =
    st === "ready" && advertised.length > 0
      ? wakeWords.filter((w) => !advertised.includes(w))
      : [];

  const toggleWord = (word) => {
    setWakeWords((prev) =>
      prev.includes(word) ? prev.filter((w) => w !== word) : [...prev, word],
    );
  };
  const addCustomWord = () => {
    const word = customWord.trim();
    setCustomWord("");
    if (word !== "" && !wakeWords.includes(word)) {
      setWakeWords((prev) => [...prev, word]);
    }
  };

  const doSave = () => {
    const advanced = { customModels };
    // Cleared optional fields are omitted, not sent as empty strings —
    // withDefaults only applies finite numbers / non-empty strings.
    const refractory = Number(refractorySeconds);
    if (refractorySeconds !== "" && Number.isFinite(refractory)) {
      advanced.refractorySeconds = refractory;
    }
    if (advertiseHost.trim() !== "") {
      advanced.advertiseHost = advertiseHost.trim();
    }
    const thresholdNumber = Number(threshold);
    const triggerNumber = Number(triggerLevel);
    const portNumber = Number(port);
    save({
      ...cfg,
      wakeWords: wakeWords.length > 0 ? wakeWords : [...DEFAULTS.wakeWords],
      threshold:
        threshold !== "" && Number.isFinite(thresholdNumber)
          ? thresholdNumber
          : DEFAULTS.threshold,
      triggerLevel:
        triggerLevel !== "" && Number.isFinite(triggerNumber)
          ? triggerNumber
          : DEFAULTS.triggerLevel,
      port:
        port !== "" && Number.isFinite(portNumber) ? portNumber : DEFAULT_PORT,
      bind,
      imageTag,
      memoryLimit,
      restartPolicy,
      advanced,
    });
    setSaved("Saved. Signal K restarts the plugin with the new configuration.");
  };

  return (
    <div style={S.root}>
      <SectionTitle>openWakeWord status</SectionTitle>
      <StatusCard
        icon="O"
        iconBackground={st === "ready" ? "#7c3aed" : undefined}
        title="openWakeWord (Wyoming)"
        meta={meta}
        state={state}
        stateTitle={st}
      />

      {/* Check/apply against the routes registerUpdateRoutes mounts; hidden
          while the plugin is disabled (they answer 503 then anyway). */}
      {st !== "not_running" && st !== "stopped" && (
        <UpdateControls
          checkUrl={`${BASE}/api/update/check`}
          applyUrl={`${BASE}/api/update/apply`}
          tag={imageTag}
          onApplied={() => void refresh()}
        />
      )}

      <SectionTitle>Settings</SectionTitle>
      <FieldRow
        label="Wake words"
        hint={
          missing.length > 0
            ? `not available on the running service: ${missing.join(", ")} ` +
              "(2.0.0 renamed ok_nabu to okay_nabu)"
            : "what satellites can listen for; clients select models per connection"
        }
        hintColor={missing.length > 0 ? stateColors.warn : undefined}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
          {listedWords.map((word) => (
            <label
              key={word}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 13,
              }}
            >
              <input
                style={S.checkbox}
                type="checkbox"
                checked={wakeWords.includes(word)}
                onChange={() => toggleWord(word)}
              />
              {word}
            </label>
          ))}
        </div>
      </FieldRow>
      <FieldRow
        label="Add wake word"
        hint="a model name not listed above (e.g. a custom model, before its first start)"
      >
        <input
          style={{ ...S.input, width: 180 }}
          value={customWord}
          onChange={(e) => setCustomWord(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCustomWord();
            }
          }}
          placeholder="model_name"
        />
        <Button variant="secondary" onClick={addCustomWord}>
          Add
        </Button>
      </FieldRow>
      <FieldRow
        label="Detection threshold"
        hint="0–1; lower = more sensitive but more false wakes"
      >
        <input
          style={{ ...S.input, width: 90 }}
          type="number"
          min="0"
          max="1"
          step="0.05"
          value={threshold}
          onChange={(e) => setThreshold(e.target.value)}
        />
      </FieldRow>
      <FieldRow
        label="Trigger level"
        hint="activations above the threshold before a detection fires; raise in noisy cabins"
      >
        <input
          style={{ ...S.input, width: 90 }}
          type="number"
          min="1"
          step="1"
          value={triggerLevel}
          onChange={(e) => setTriggerLevel(e.target.value)}
        />
      </FieldRow>
      <FieldRow label="Image version">
        <VersionSelect
          value={imageTag}
          onChange={setImageTag}
          versions={versions.versions}
          floatingOptions={[
            { tag: "auto", label: "auto (pinned release, recommended)" },
          ]}
          loading={versions.loading}
          error={versions.versionsError}
          onRefresh={versions.refresh}
        />
      </FieldRow>
      <FieldRow
        label="Host port"
        hint="satellites connect to tcp://<boat-server>:<this port>"
      >
        <input
          style={{ ...S.input, width: 90 }}
          type="number"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
      </FieldRow>
      <FieldRow
        label="Bind address"
        hint={
          bind === "0.0.0.0"
            ? "LAN-reachable — required for remote satellites; Wyoming has no authentication, firewall/VLAN on marina wifi"
            : "only satellites on this machine can reach the service"
        }
        hintColor={bind === "0.0.0.0" ? stateColors.warn : undefined}
      >
        <select
          style={S.select}
          value={bind}
          onChange={(e) => setBind(e.target.value)}
        >
          <option value="0.0.0.0">0.0.0.0 (all interfaces)</option>
          <option value="127.0.0.1">127.0.0.1 (this machine only)</option>
        </select>
      </FieldRow>

      <CollapsibleSection title="Advanced">
        <FieldRow
          label="Refractory seconds"
          hint="optional minimum seconds between re-detections; upstream default 2.0"
        >
          <input
            style={{ ...S.input, width: 90 }}
            type="number"
            step="0.5"
            value={refractorySeconds}
            onChange={(e) => setRefractorySeconds(e.target.value)}
          />
        </FieldRow>
        <FieldRow
          label="Custom wake word models"
          hint={
            <>
              load your own wake words (--custom-model-dir). Add, train and
              convert them in the{" "}
              <a href="/signalk-openwakeword/" target="_blank" rel="noreferrer">
                Custom wake words
              </a>{" "}
              webapp.
            </>
          }
        >
          <input
            style={S.checkbox}
            type="checkbox"
            checked={customModels}
            onChange={(e) => setCustomModels(e.target.checked)}
          />
        </FieldRow>
        <FieldRow
          label="Advertise host"
          hint="optional host override for the advertised tcp:// URI (containerized Signal K, multi-NIC)"
        >
          <input
            style={{ ...S.input, width: 180 }}
            value={advertiseHost}
            onChange={(e) => setAdvertiseHost(e.target.value)}
            placeholder="automatic"
          />
        </FieldRow>
        <FieldRow label="Memory limit" hint='hard cap, e.g. "384m" or "1g"'>
          <input
            style={{ ...S.input, width: 90 }}
            value={memoryLimit}
            onChange={(e) => setMemoryLimit(e.target.value)}
          />
        </FieldRow>
        <FieldRow label="Restart policy">
          <select
            style={S.select}
            value={restartPolicy}
            onChange={(e) => setRestartPolicy(e.target.value)}
          >
            <option value="unless-stopped">unless-stopped</option>
            <option value="always">always</option>
            <option value="no">no</option>
          </select>
        </FieldRow>
      </CollapsibleSection>

      <div style={{ marginTop: 24 }}>
        <Button onClick={doSave}>Save Configuration</Button>
      </div>
      <ActionStatus message={saved} />
    </div>
  );
}
