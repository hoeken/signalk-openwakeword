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

/**
 * Text to take over to Colab, with a copy button.
 *
 * Signal K is usually served over plain HTTP, where the browser refuses the
 * clipboard API outright — so failing to copy is a normal outcome here, not an
 * error case. When it happens we select the text instead, leaving one
 * keystroke rather than a fiddly drag.
 */
function CopyBlock({ text, label }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const select = () => {
    const node = ref.current;
    if (!node || typeof window.getSelection !== "function") return;
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setFailed(false);
      setTimeout(() => setCopied(false), 2000);
      return;
    }
    setFailed(true);
    select();
  };

  return (
    <>
      <pre
        className="config selectable"
        ref={ref}
        onClick={select}
        title="Click to select"
      >
        {text}
      </pre>
      {failed && (
        <p className="notice warn">
          This browser won't let a page copy for you over plain HTTP (it needs
          HTTPS). The text is selected — press <kbd>Ctrl</kbd>+<kbd>C</kbd> to
          copy it.
        </p>
      )}
      <button onClick={copy}>{copied ? "Copied" : label}</button>
    </>
  );
}

export default function TrainWizard({ onClose }) {
  const [step, setStep] = useState(1);
  const [phrase, setPhrase] = useState("");
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState("");
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
              Take your phrase with you — the notebook's first cell asks for it:
            </p>
            <CopyBlock text={plan.phrase} label="Copy the phrase" />
            <p>
              In the notebook, choose <strong>Runtime → Run all</strong>. It
              asks Colab for a GPU itself, so there is no runtime to pick. The
              first cell stops with a <strong>Wake word:</strong> box — paste{" "}
              <strong>“{plan.phrase}”</strong> in, press Enter, and the rest
              runs unattended. Leave the tab open: Colab wipes everything if the
              session drops.
            </p>
            <details className="troubleshoot">
              <summary>If something goes wrong</summary>
              <p className="hint">
                After the wake-word question it should print{" "}
                <code>GPU present.</code> If it stops there instead, your Google
                account has no GPU capacity right now — wait a few hours, or use
                a ready-made wake word.
              </p>
              <p className="hint">
                If you come back to{" "}
                <code>No such file or directory: my_model.yaml</code>, the
                session was recycled and it has to start over.
              </p>
              <p className="hint">
                Missed the question, or using a different copy of the notebook?
                Overwrite these two lines in the cell that builds the training
                config, then run the notebook from there:
              </p>
              <CopyBlock text={plan.config} label="Copy these lines" />
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
