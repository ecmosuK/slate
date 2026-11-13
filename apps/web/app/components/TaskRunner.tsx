"use client";

import { useEffect, useState } from "react";

import { DEFAULT_JOB_MODEL } from "@/lib/job-defaults";

type JobMode = "plan" | "build";
type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface JobSummary {
  id: string;
  project: string;
  task: string;
  mode: JobMode;
  model: string | null;
  status: JobStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  sessionID: string | null;
  error: string | null;
  command: string;
  costMicros: number;
}

interface JobDetail extends JobSummary {
  log: string;
}

function dollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

interface ListBody {
  ok: boolean;
  jobs?: JobSummary[];
  error?: string;
}

interface DetailBody {
  ok: boolean;
  job?: JobDetail;
  error?: string;
}

function statusLabel(status: JobStatus): string {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function shortTask(task: string): string {
  return task.length <= 80 ? task : `${task.slice(0, 80)}…`;
}

/** What to show in the terminal when a run has produced no output yet. */
function logPlaceholder(job: JobDetail): string {
  if (job.log !== "") return job.log;
  if (job.status === "running") return "Waiting for output…";
  if (job.status === "queued") return "Queued — waiting for the current task to finish.";
  return "No output was captured.";
}

export default function TaskRunner({
  slug,
  folder,
  suggestedTask,
}: {
  slug: string;
  folder: string;
  suggestedTask: string;
}) {
  const [task, setTask] = useState(suggestedTask);
  const [mode, setMode] = useState<JobMode>("build");
  const [model, setModel] = useState(DEFAULT_JOB_MODEL);
  const [confirmed, setConfirmed] = useState(false);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<JobDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [minimised, setMinimised] = useState(false);

  useEffect(() => {
    setTask(suggestedTask);
    setSelectedId(null);
    setSelected(null);
    setConfirmed(false);
  }, [slug, suggestedTask]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const response = await fetch(`/api/jobs?project=${encodeURIComponent(slug)}`, {
          cache: "no-store",
        });
        const body = (await response.json()) as ListBody;
        if (cancelled || !response.ok || !body.ok) return;
        const next = body.jobs ?? [];
        setJobs(next);
        setSelectedId((current) => current ?? next[0]?.id ?? null);
      } catch {
        // A poll failure is not fatal; the next tick retries.
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [slug]);

  useEffect(() => {
    if (selectedId === null) {
      setSelected(null);
      return;
    }

    let cancelled = false;
    const tick = async () => {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(selectedId)}`, {
          cache: "no-store",
        });
        const body = (await response.json()) as DetailBody;
        if (cancelled || !response.ok || !body.ok || body.job === undefined) return;
        setSelected(body.job);
      } catch {
        // Keep the last log visible while polling fails.
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedId]);

  const running = jobs.find((job) => job.status === "running");
  const queuedCount = jobs.filter((job) => job.status === "queued").length;

  async function start(event: React.FormEvent) {
    event.preventDefault();
    if (!confirmed) {
      setError("Tick the confirmation before starting opencode.");
      return;
    }
    if (task.trim() === "") {
      setError("Describe the task first.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project: slug, task, mode, model, confirm: true }),
      });
      const body = (await response.json()) as { ok: boolean; job?: JobSummary; error?: string };
      if (!response.ok || !body.ok || body.job === undefined) {
        throw new Error(body.error ?? `The task could not be started (${response.status}).`);
      }
      setJobs((current) => [body.job as JobSummary, ...current]);
      setSelectedId(body.job.id);
      setTask("");
      setConfirmed(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(job: JobDetail) {
    setBusy(true);
    setError(null);
    setCancellingId(job.id);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error ?? "The task could not be cancelled.");
      setSelected({ ...job, status: "cancelled" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCancellingId(null);
      setBusy(false);
    }
  }

  async function remove(job: JobSummary) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !body.ok) throw new Error(body.error ?? "The run could not be deleted.");
      setJobs((current) => current.filter((entry) => entry.id !== job.id));
      if (selectedId === job.id) {
        setSelectedId(null);
        setSelected(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card task-runner">
      <div className="project-card-head">
        <h2>Run a task</h2>
        <div className="row">
          <span className="chip">opencode CLI</span>
          <button
            type="button"
            className="task-collapse-button"
            onClick={() => setMinimised((current) => !current)}
            aria-expanded={!minimised}
          >
            {minimised ? "Expand" : "Minimise"}
          </button>
        </div>
      </div>

      {minimised ? (
        <p className="meta">
          {jobs.length === 0
            ? "No tasks have run for this project yet."
            : `${jobs.length} run(s) · ${
                running !== undefined ? "one is running" : "none running"
              }${queuedCount > 0 ? ` · ${queuedCount} queued` : ""}`}
        </p>
      ) : (
        <>
      <p className="meta">
        Starts <code>opencode run</code> in <code>{folder}</code> as your Windows user. The default
        model is <code>{DEFAULT_JOB_MODEL}</code>, OpenRouter’s free router.
      </p>
      <p className="notice warn">
        This can read and write files and run shell commands with your account. “Plan” mode
        prevents project file edits; “Build” mode allows them. Nothing runs until you confirm.
      </p>

      <form className="job-form" onSubmit={start}>
        <div className="job-form-row">
          <label className="field">
            <span>Mode</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as JobMode)}>
              <option value="plan">Plan — no project edits</option>
              <option value="build">Build — can edit files</option>
            </select>
          </label>

          <label className="field">
            <span>Model</span>
            <input
              value={model}
              onChange={(event) => setModel(event.target.value)}
              placeholder={DEFAULT_JOB_MODEL}
            />
          </label>
        </div>

        <label className="field">
          <span>Task</span>
          <textarea
            value={task}
            onChange={(event) => setTask(event.target.value)}
            placeholder="What should opencode do in this project?"
            rows={4}
          />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>I understand opencode will act with my account’s permissions.</span>
        </label>

        <div className="row">
          <button
            className="primary"
            type="submit"
            disabled={busy || !confirmed || task.trim() === ""}
          >
            {busy ? "Starting…" : running !== undefined ? "Queue with opencode" : "Start with opencode"}
          </button>
          {running !== undefined && (
            <span className="meta">
              A task is running{queuedCount > 0 ? ` · ${queuedCount} queued` : ""}.
            </span>
          )}
        </div>
      </form>

      {error !== null && <p className="notice bad">{error}</p>}

      <div className="job-history">
        <div className="label">Runs</div>
        {jobs.length === 0 ? (
          <p className="meta">No tasks have run for this project yet.</p>
        ) : (
          <ul className="job-list">
            {jobs.map((job) => (
              <li key={job.id}>
                <div className={job.id === selectedId ? "job-row active" : "job-row"}>
                  <button
                    type="button"
                    className="job-row-select"
                    onClick={() => setSelectedId(job.id)}
                  >
                    <span className={`job-status ${job.status}`}>{statusLabel(job.status)}</span>
                    <span className="job-task">{shortTask(job.task)}</span>
                    <span className="job-meta">
                      {job.mode} · {new Date(job.createdAt).toLocaleString()}
                      {job.costMicros > 0 && <span> · {dollars(job.costMicros)} spent</span>}
                    </span>
                  </button>
                  {(job.status === "succeeded" ||
                    job.status === "failed" ||
                    job.status === "cancelled") && (
                    <button
                      type="button"
                      className="job-delete"
                      onClick={() => void remove(job)}
                      disabled={busy}
                      aria-label={`Delete the run of ${shortTask(job.task)}`}
                      title="Delete this run"
                    >
                      Delete
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected !== null && (
        <div className="job-detail">
          <div className="project-card-head">
            <h3>{shortTask(selected.task)}</h3>
            <span className={`job-status ${selected.status}`}>{statusLabel(selected.status)}</span>
          </div>
          <div className="meta">
            <span>{selected.mode}</span>
            {selected.model !== null && <span>· {selected.model}</span>}
            {selected.sessionID !== null && <span>· session {selected.sessionID}</span>}
            {selected.exitCode !== null && <span>· exit {selected.exitCode}</span>}
            {selected.costMicros > 0 && <span> · {dollars(selected.costMicros)} spent</span>}
          </div>
          <p className="meta">
            <code>{selected.command}</code>
          </p>
          {selected.error !== null && <p className="notice bad">{selected.error}</p>}
          <div className="row job-detail-actions">
            {(selected.status === "running" || selected.status === "queued") && (
              <button
                type="button"
                onClick={() => void cancel(selected)}
                disabled={busy}
              >
                {cancellingId === selected.id
                  ? "Cancelling…"
                  : selected.status === "queued"
                    ? "Remove from queue"
                    : "Cancel task"}
              </button>
            )}
            {(selected.status === "succeeded" ||
              selected.status === "failed" ||
              selected.status === "cancelled") && (
              <button type="button" onClick={() => void remove(selected)} disabled={busy}>
                Delete run
              </button>
            )}
          </div>
          <pre className="job-log">{logPlaceholder(selected)}</pre>
        </div>
      )}
        </>
      )}
    </section>
  );
}
