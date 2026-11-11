"use client";

import { useEffect, useState } from "react";

import { DEFAULT_JOB_MODEL } from "@/lib/job-defaults";

type JobMode = "plan" | "build";
type JobStatus = "running" | "succeeded" | "failed" | "cancelled";

interface JobSummary {
  id: string;
  project: string;
  task: string;
  mode: JobMode;
  model: string | null;
  status: JobStatus;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  sessionID: string | null;
  error: string | null;
  command: string;
}

interface JobDetail extends JobSummary {
  log: string;
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
      setBusy(false);
    }
  }

  return (
    <section className="card task-runner">
      <div className="project-card-head">
        <h2>Run a task</h2>
        <span className="chip">opencode CLI</span>
      </div>

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
            disabled={busy || !confirmed || task.trim() === "" || running !== undefined}
          >
            {busy ? "Starting…" : "Start with opencode"}
          </button>
          {running !== undefined && <span className="meta">A task is already running.</span>}
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
                <button
                  type="button"
                  className={job.id === selectedId ? "job-row active" : "job-row"}
                  onClick={() => setSelectedId(job.id)}
                >
                  <span className={`job-status ${job.status}`}>{statusLabel(job.status)}</span>
                  <span className="job-task">{shortTask(job.task)}</span>
                  <span className="job-meta">
                    {job.mode} · {new Date(job.createdAt).toLocaleString()}
                  </span>
                </button>
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
          </div>
          <p className="meta">
            <code>{selected.command}</code>
          </p>
          {selected.error !== null && <p className="notice bad">{selected.error}</p>}
          {selected.status === "running" && (
            <button type="button" onClick={() => void cancel(selected)} disabled={busy}>
              Cancel task
            </button>
          )}
          <pre className="job-log">{selected.log === "" ? "Waiting for output…" : selected.log}</pre>
        </div>
      )}
    </section>
  );
}
