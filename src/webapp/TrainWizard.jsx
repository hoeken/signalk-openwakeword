/**
 * Three-step "create a new wake word" wizard.
 *
 * It is honest about where the work happens: the GPU step runs on Colab
 * because openWakeWord training needs a ~17 GB feature set and CUDA, neither
 * of which a Signal K server has. What the wizard removes is everything
 * around that — choosing a phrase that actually works, filling in the
 * notebook config, and dealing with the ONNX file that comes back.
 */

import React, { useState } from "react";
import { useStore } from "./store.js";

export default function TrainWizard({ onClose }) {
  const [step, setStep] = useState(1);
  const [phrase, setPhrase] = useState("");
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
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
    try {
      await navigator.clipboard.writeText(plan.config);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy — select the text and copy it manually.");
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
              Nothing to record and no scripts to write: you'll edit two lines
              in a notebook, press Run, and come back with the finished file.
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
            <label htmlFor="config">
              In the notebook, find the cell marked{" "}
              <strong>★ EDIT THESE TWO LINES ★</strong> and replace its two
              lines with these:
            </label>
            <pre id="config" className="config">
              {plan.config}
            </pre>
            <p className="hint">
              That is the only edit you make — leave every other cell alone.
              Then choose <strong>Runtime → Run all</strong> and leave it to
              work.
            </p>
            <div className="row">
              <button onClick={copyConfig}>
                {copied ? "Copied" : "Copy these lines"}
              </button>
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
