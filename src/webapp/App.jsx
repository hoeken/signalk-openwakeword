/**
 * Custom wake words — manage installed models, add new ones, and start a
 * training run.
 */

import React, { useEffect, useRef, useState } from "react";
import { useStore } from "./store.js";
import TrainWizard from "./TrainWizard.jsx";

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ModelRow({ model, onConvert, onDelete, busy, customModelsEnabled }) {
  // Three different states get confused here, so be precise:
  //   loaded    — the service has the model in memory. It loads EVERY model it
  //               can find; this says nothing about what the boat listens for.
  //   selected  — the model's id is in the plugin's wakeWords, which is what
  //               actually decides the boat's wake word.
  //   neither   — installed but not picked up, usually a pending restart or
  //               customModels being off. This is where silent failures live.
  const status =
    model.format === "onnx"
      ? model.converted
        ? { label: "source file", kind: "muted" }
        : { label: "needs converting", kind: "warn" }
      : model.selected && model.live
        ? { label: "listening", kind: "ok" }
        : model.selected
          ? { label: "selected — restart to load", kind: "warn" }
          : model.live
            ? { label: "ready, not selected", kind: "muted" }
            : customModelsEnabled
              ? { label: "installed — restart to load", kind: "warn" }
              : { label: "installed — not enabled", kind: "warn" };

  return (
    <tr>
      <td>
        <code className="model-id">{model.id}</code>
        <div className="filename">{model.filename}</div>
      </td>
      <td>
        <span className="badge">{model.format}</span>
      </td>
      <td className="numeric">{formatSize(model.bytes)}</td>
      <td>
        <span className={`status ${status.kind}`}>{status.label}</span>
      </td>
      <td className="actions">
        {model.format === "onnx" && !model.converted && (
          <button onClick={() => onConvert(model.filename)} disabled={busy}>
            Convert
          </button>
        )}
        <button
          className="danger"
          onClick={() => onDelete(model.filename)}
          disabled={busy}
        >
          Delete
        </button>
      </td>
    </tr>
  );
}

export default function App() {
  const {
    models,
    loading,
    notice,
    busyWith,
    customModelsEnabled,
    refresh,
    upload,
    convert,
    remove,
    dismissNotice,
  } = useStore();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef(null);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleFiles = async (files) => {
    for (const file of Array.from(files ?? [])) {
      await upload(file);
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const onDrop = async (event) => {
    event.preventDefault();
    setDragging(false);
    await handleFiles(event.dataTransfer.files);
  };

  const tflite = models.filter((m) => m.format === "tflite");
  const unconverted = models.filter((m) => m.format === "onnx" && !m.converted);

  return (
    <main>
      <header>
        <h1>Custom wake words</h1>
        <p className="lede">
          Teach the boat to answer to its own name. Models live alongside the
          built-in wake words like <code>okay_nabu</code>.
        </p>
      </header>

      {notice && (
        <div className={`notice ${notice.kind}`} role="status">
          <div className="notice-body">
            <strong>{notice.text}</strong>
            {notice.detail && <pre className="detail">{notice.detail}</pre>}
          </div>
          <button
            className="icon-button"
            onClick={dismissNotice}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {!loading && tflite.length > 0 && !customModelsEnabled && (
        <div className="notice warn">
          <div className="notice-body">
            <strong>
              Custom models are switched off, so these are being ignored.
            </strong>
            <span>
              Turn on “Custom wake word models” in the openWakeWord plugin
              settings, then restart the plugin.
            </span>
          </div>
        </div>
      )}

      {unconverted.length > 0 && (
        <div className="notice warn">
          <div className="notice-body">
            <strong>
              {unconverted.length === 1
                ? "One model needs"
                : `${unconverted.length} models need`}{" "}
              converting.
            </strong>
            <span>
              The wake word service only loads <code>.tflite</code> files.
              Convert them and they'll work.
            </span>
          </div>
        </div>
      )}

      <section>
        <h2>Installed models</h2>
        {loading ? (
          <p className="muted">Loading…</p>
        ) : models.length === 0 ? (
          <p className="empty">
            No custom models yet. Add one below, or create a brand new wake word
            from a phrase.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Wake word</th>
                <th>Format</th>
                <th className="numeric">Size</th>
                <th>Status</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <ModelRow
                  key={m.filename}
                  model={m}
                  busy={busyWith !== null}
                  customModelsEnabled={customModelsEnabled}
                  onConvert={convert}
                  onDelete={remove}
                />
              ))}
            </tbody>
          </table>
        )}
        {tflite.length > 0 && (
          <p className="hint">
            The service keeps every model loaded, so “ready” only means it is
            available. The boat listens for the ones named in the openWakeWord
            plugin's <strong>wake words</strong> setting — those show as{" "}
            <strong>listening</strong> here. Add or remove them there, then
            restart the plugin.
          </p>
        )}
      </section>

      <section>
        <h2>Add a model</h2>
        <div
          className={`dropzone ${dragging ? "dragging" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInput.current?.click()}
        >
          <input
            ref={fileInput}
            type="file"
            accept=".tflite,.onnx"
            multiple
            hidden
            onChange={(e) => handleFiles(e.target.files)}
            aria-label="Model files"
          />
          <p>
            <strong>Drop a model here</strong> or click to choose one.
          </p>
          <p className="hint">
            <code>.tflite</code> files are installed as-is. <code>.onnx</code>{" "}
            files — what the training notebooks produce — are converted here
            automatically and checked against the original.
          </p>
        </div>
        {busyWith && <p className="notice info">Working on {busyWith}…</p>}
      </section>

      <section>
        <h2>Create a new wake word</h2>
        <p>
          Don't have a model yet? Start from a phrase. Training runs on a free
          Google Colab GPU and takes about an hour — this server has no graphics
          card, so it can't be done here.
        </p>
        <button className="primary" onClick={() => setWizardOpen(true)}>
          Create a wake word
        </button>
      </section>

      {wizardOpen && <TrainWizard onClose={() => setWizardOpen(false)} />}
    </main>
  );
}
