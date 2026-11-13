"use client";

import { useState } from "react";

import { DEFAULT_JOB_MODEL } from "@/lib/job-defaults";

export type DispatchMode = "plan" | "build";

interface TaskDispatchProps {
  selectedCount: number;
  mode: DispatchMode;
  model: string;
  onModeChange: (mode: DispatchMode) => void;
  onModelChange: (model: string) => void;
  onSendToPlanBot: () => Promise<void>;
  onSendToRun: () => Promise<void>;
  onClearSelection: () => void;
}

export default function TaskDispatch({
  selectedCount,
  mode,
  model,
  onModeChange,
  onModelChange,
  onSendToPlanBot,
  onSendToRun,
  onClearSelection,
}: TaskDispatchProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>, ok: string | null) {
    setNotice(null);
    setError(null);
    setBusy(true);
    try {
      await action();
      if (ok !== null) setNotice(ok);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card task-dispatch-card">
      <div className="project-card-head">
        <h2>Send to…</h2>
        <span className="meta">
          {selectedCount === 0 ? "nothing selected" : `${selectedCount} selected`}
        </span>
      </div>

      <p className="meta">
        {selectedCount === 0
          ? "Select tasks in the Tasks section to send them."
          : `${selectedCount} task(s) selected in the Tasks section.`}
      </p>

      <div className="task-dispatch">
        <div className="job-form-row">
          <label className="field">
            <span>Run mode</span>
            <select
              value={mode}
              onChange={(event) => onModeChange(event.target.value as DispatchMode)}
              disabled={busy}
            >
              <option value="plan">Plan — no project edits</option>
              <option value="build">Build — can edit files</option>
            </select>
          </label>
          <label className="field">
            <span>Run model</span>
            <input
              value={model}
              onChange={(event) => onModelChange(event.target.value)}
              placeholder={DEFAULT_JOB_MODEL}
              disabled={busy}
            />
          </label>
        </div>
        <div className="row">
          <button
            type="button"
            onClick={() => void run(onSendToPlanBot, null)}
            disabled={busy || selectedCount === 0}
          >
            {busy ? "Working…" : "Send to plan bot"}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void run(onSendToRun, null)}
            disabled={busy || selectedCount === 0}
          >
            {busy ? "Working…" : "Send to Run a task"}
          </button>
          <button type="button" onClick={onClearSelection} disabled={busy || selectedCount === 0}>
            Clear selection
          </button>
        </div>
        <p className="meta">
          “Send to plan bot” sends selected tasks and asks the agent what it is unsure about. “Send to Run
          a task” queues them on the server (runs in order if one is already running).
        </p>
      </div>

      {notice !== null && <p className="notice">{notice}</p>}
      {error !== null && <p className="notice bad">{error}</p>}
    </section>
  );
}
