/**
 * Three-step "create a new wake word" wizard.
 *
 * It is honest about where the work happens: the GPU step runs on Colab
 * because openWakeWord training needs a ~17 GB feature set and CUDA, neither
 * of which a Signal K server has. What the wizard removes is everything
 * around that — choosing a phrase that actually works, filling in the
 * notebook config, and dealing with the ONNX file that comes back.
 */

import React, { useRef, useState } from "react";
import { useStore } from "./store.js";
import { copyText } from "./clipboard.js";

export default function TrainWizard({ onClose }) {
  const [step, setStep] = useState(1);
  const [phrase, setPhrase] = useState("");
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const configRef = useRef(null);
  const upload = useStore((s) => s.upload);
  const busyWith = useStore((s) => s.busyWith);

  const check = async () => {
    setError("");
    try {
      setPlan(await useStore.getState().trainingPlan(phrase));
      setStep(2);
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const copyConfig = async () => {
    if (await copyText(plan.config)) {
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
      return;
    }
    // Last resort: select the text for them, so it is one keystroke away
    // rather than a fiddly drag over two lines of code.
    setCopyFailed(true);
    selectConfig();
  };

  /** Put the two config lines under the user's selection. */
  const selectConfig = () => {
    const node = configRef.current;
    if (!node || typeof window.getSelection !== "function") return;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (await upload(file)) onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Create a new wake word"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Create a new wake word</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <ol className="steps" aria-label="Progress">
          {["Choose a phrase", "Train it", "Install it"].map((label, i) => (
            <li
              key={label}
              className={
                step === i + 1 ? "current" : step > i + 1 ? "done" : ""
              }
            >
              <span className="step-number">{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {step === 1 && (
          <div className="modal-body">
            <label htmlFor="phrase">What should the boat answer to?</label>
            <input
              id="phrase"
              type="text"
              value={phrase}
              placeholder="hey seabird"
              autoFocus
              onChange={(e) => setPhrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && phrase.trim() && check()}
            />
            <p className="hint">
              Three or more syllables works best, and something distinctive
              beats a common word — the detector matches on sound, so an
              everyday phrase will wake the boat during normal conversation.
            </p>
            <p className="hint">
              Nothing to record and nothing to configure: you'll open a
              notebook, press Run, and come back with the finished file.
            </p>
            {error && <p className="notice error">{error}</p>}
            <div className="modal-actions">
              <button onClick={onClose}>Cancel</button>
              <button
                className="primary"
                disabled={phrase.trim().length < 2}
                onClick={check}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 2 && plan && (
          <div className="modal-body">
            {plan.advice.map((a, i) => (
              <p
                key={i}
                className={`notice ${a.level === "warn" ? "warn" : "ok"}`}
              >
                {a.message}
              </p>
            ))}
            <p>
              Training runs on Google Colab's GPU: about 75–90 minutes on a paid
              Colab plan, and roughly twice that on the free tier. It cannot run
              on this Signal K server — the training data alone is around 17 GB
              and it needs a graphics card.
            </p>
            <p className="hint">
              You don't need a microphone. The notebook synthesises the training
              audio by having a speech engine say your phrase thousands of times
              in different voices.
            </p>
            <p>
              The notebook opens already set to <strong>“{plan.phrase}”</strong>{" "}
              and asks Colab for a GPU, so there is nothing to fill in. Choose{" "}
              <strong>Runtime → Run all</strong> and leave the tab open — Colab
              wipes everything if the session drops.
            </p>
            <details className="troubleshoot">
              <summary>If something goes wrong</summary>
              <p className="hint">
                The first cell should print <code>GPU present.</code> If it
                stops there instead, your Google account has no GPU capacity
                right now — wait a few hours, or use a ready-made wake word.
              </p>
              <p className="hint">
                If you come back to{" "}
                <code>No such file or directory: my_model.yaml</code>, the
                session was recycled and it has to start over.
              </p>
              <p className="hint">
                Using a different copy of the notebook? Set the wake word by
                hand in the cell marked{" "}
                <strong>★ EDIT THESE TWO LINES ★</strong>:
              </p>
              <pre
                id="config"
                className="config selectable"
                ref={configRef}
                onClick={selectConfig}
                title="Click to select"
              >
                {plan.config}
              </pre>
              {copyFailed && (
                <p className="notice warn">
                  This browser won't let a page copy for you over plain HTTP (it
                  needs HTTPS). The lines are selected — press <kbd>Ctrl</kbd>+
                  <kbd>C</kbd> to copy them.
                </p>
              )}
              <button onClick={copyConfig}>
                {copied ? "Copied" : "Copy these lines"}
              </button>
            </details>
            <div className="row">
              <a
                className="button primary"
                href={plan.notebookUrl}
                target="_blank"
                rel="noreferrer"
              >
                Open the training notebook
              </a>
            </div>
            <p className="hint">
              The notebook produces <code>{plan.slug}.onnx</code>. Come back
              here when it's done — you don't need to convert it yourself.
            </p>
            <div className="modal-actions">
              <button onClick={() => setStep(1)}>Back</button>
              <button className="primary" onClick={() => setStep(3)}>
                I have the file
              </button>
            </div>
          </div>
        )}

        {step === 3 && plan && (
          <div className="modal-body">
            <p>
              Upload the <code>.onnx</code> file the notebook produced. It is
              converted to the format the wake word service needs, checked
              against the original to make sure the conversion was faithful, and
              installed.
            </p>
            <input
              type="file"
              accept=".onnx,.tflite"
              onChange={onFile}
              disabled={busyWith !== null}
              aria-label="Trained model file"
            />
            {busyWith && <p className="notice info">Working on {busyWith}…</p>}
            <p className="hint">
              Once installed, select it as a wake word and restart the plugin.
            </p>
            <div className="modal-actions">
              <button onClick={() => setStep(2)}>Back</button>
              <button onClick={onClose}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
