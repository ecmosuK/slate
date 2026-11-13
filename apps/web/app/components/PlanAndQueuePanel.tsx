"use client";

import { forwardRef, useImperativeHandle, useRef, useState } from "react";

import Chat, { type ChatHandle } from "./Chat";

export interface RunQueueResult {
  notice?: string;
  error?: string;
}

export interface PlanAndQueueHandle {
  sendToPlanAgent: (message: string) => Promise<void>;
  sendTasksToRun: (
    tasks: string[],
    mode?: "plan" | "build",
    model?: string,
  ) => Promise<RunQueueResult>;
}

interface PlanAndQueuePanelProps {
  slug: string;
  /** Called when the agent changed the project, so the page can refresh. */
  onChanged?: () => void;
}

const PlanAndQueuePanel = forwardRef<PlanAndQueueHandle, PlanAndQueuePanelProps>(
  function PlanAndQueuePanel({ slug, onChanged }, ref) {
    const chatRef = useRef<ChatHandle | null>(null);
    const [busy, setBusy] = useState(false);
    const [minimised, setMinimised] = useState(false);

    async function sendToPlanAgent(message: string): Promise<void> {
      if (chatRef.current === null) {
        throw new Error("The plan agent is not ready yet.");
      }
      setBusy(true);
      try {
        await chatRef.current.sendPrompt(message);
      } finally {
        setBusy(false);
      }
    }

    async function sendTasksToRun(
      tasks: string[],
      mode: "plan" | "build" = "build",
      model = "",
    ): Promise<RunQueueResult> {
      setBusy(true);
      try {
        const results: { ok: boolean; status?: string; error?: string }[] = [];
        for (const task of tasks) {
          const response = await fetch("/api/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              project: slug,
              task,
              mode,
              model,
              confirm: true,
            }),
          });
          const body = (await response.json()) as {
            ok: boolean;
            job?: { id: string; status: string };
            error?: string;
          };
          if (!response.ok || !body.ok || body.job === undefined) {
            results.push({ ok: false, error: body.error ?? `Could not queue "${task}"` });
          } else {
            results.push({ ok: true, status: body.job.status });
          }
        }

        const okCount = results.filter((r) => r.ok).length;
        const queued = results.filter((r) => r.ok && r.status === "queued").length;
        const started = results.filter((r) => r.ok && r.status === "running").length;
        const failed = results.filter((r) => !r.ok);
        let noticeMsg: string | undefined;
        let errorMsg: string | undefined;
        if (okCount > 0) {
          const parts: string[] = [];
          if (started > 0) parts.push(`${started} started`);
          if (queued > 0) parts.push(`${queued} queued`);
          noticeMsg = `Sent ${okCount} task(s) to Run a task${parts.length ? ` (${parts.join(", ")})` : ""}.`;
        }
        if (failed.length > 0) {
          errorMsg = failed.map((f) => f.error ?? "Failed to queue a task").join(" ");
        }
        return { notice: noticeMsg, error: errorMsg };
      } catch (caught) {
        return { error: caught instanceof Error ? caught.message : String(caught) };
      } finally {
        setBusy(false);
      }
    }

    useImperativeHandle(ref, () => ({ sendToPlanAgent, sendTasksToRun }));

    return (
      <section className="card plan-agent-section">
        <div className="project-card-head">
          <h2>Plan agent</h2>
          <div className="row">
            <span className="chip">plan agent</span>
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
            The plan agent is minimised. Expand it to workshop tasks and goals.
          </p>
        ) : (
          <>
            <p className="meta">
              Workshop selected tasks or goals with the project agent in plan mode (it can read
              context, add or edit goals, and add tasks). “Send to plan bot” from the Tasks or
              Goals section lands here.
            </p>
            <div className="plan-agent-pane">
              <Chat
                ref={chatRef}
                project={slug}
                mode="goals"
                storageKeySuffix="plan-goals"
                subtitle="Plan mode: reads the project, manages goals and plan tasks through Slate's tools (no project creation, no plan metadata edits, no completing tasks)."
                placeholder="Workshop ideas with the plan agent…"
                emptyTitle="Send selected tasks or goals here to workshop them, or ask the agent to add/edit goals and create tasks."
                emptyBody="Same agent as the project chat, held to plan work: it can read projects, goals and tasks and can add or update goals and plan tasks. It cannot create projects, edit plan metadata (status/milestone/goal/log) or complete existing tasks."
                onChanged={onChanged}
              />
            </div>
          </>
        )}
        {busy && <p className="meta">Working…</p>}
      </section>
    );
  },
);

export default PlanAndQueuePanel;
