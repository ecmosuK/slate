"use client";

import { useEffect, useState } from "react";

type GoalStatus = "pending" | "done";
type GoalPriority = "high" | "medium" | "low";

const PRIORITIES: GoalPriority[] = ["high", "medium", "low"];

interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
  priority: GoalPriority;
  tasks?: string[];
  createdAt: string;
  updatedAt: string;
}

interface GoalsResponse {
  ok: boolean;
  goals?: Goal[];
  error?: string;
}

async function readBody(response: Response): Promise<GoalsResponse> {
  try {
    return (await response.json()) as GoalsResponse;
  } catch {
    return { ok: false, error: `The server returned ${response.status}` };
  }
}

function priorityLabel(priority: GoalPriority): string {
  if (priority === "high") return "High";
  if (priority === "low") return "Low";
  return "Medium";
}

export default function Goals({
  slug,
  onSendGoalsToPlanAgent,
  refreshSignal,
}: {
  slug: string;
  onSendGoalsToPlanAgent?: (
    goals: { title: string; description: string; priority: GoalPriority }[],
  ) => Promise<void>;
  /** Changing this reloads the goals, so a change made elsewhere shows up. */
  refreshSignal?: number;
}) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<GoalPriority>("medium");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/goals/${encodeURIComponent(slug)}`, {
          cache: "no-store",
        });
        const body = await readBody(response);
        if (!response.ok || !body.ok) throw new Error(body.error ?? "Could not load goals");
        if (!cancelled) setGoals(body.goals ?? []);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, refreshSignal]);

  async function send(method: string, payload?: unknown, query = ""): Promise<Goal[]> {
    const response = await fetch(`/api/goals/${encodeURIComponent(slug)}${query}`, {
      method,
      headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = await readBody(response);
    if (!response.ok || !body.ok) throw new Error(body.error ?? "The change was not saved");
    const next = body.goals ?? [];
    setGoals(next);
    return next;
  }

  async function addGoal(event: React.FormEvent) {
    event.preventDefault();
    if (title.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await send("POST", {
        title: title.trim(),
        description: description.trim(),
        priority,
      });
      setTitle("");
      setDescription("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggleGoal(goal: Goal) {
    setBusy(true);
    setError(null);
    try {
      await send("PATCH", { id: goal.id, status: goal.status === "done" ? "pending" : "done" });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function setGoalPriority(goal: Goal, next: GoalPriority) {
    if (next === goal.priority) return;
    setBusy(true);
    setError(null);
    try {
      await send("PATCH", { id: goal.id, priority: next });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function moveGoal(goal: Goal, move: "up" | "down") {
    setBusy(true);
    setError(null);
    try {
      await send("PATCH", { id: goal.id, move });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function startEditing(goal: Goal) {
    setEditingId(goal.id);
    setDraftTitle(goal.title);
    setDraftDescription(goal.description);
    setError(null);
  }

  async function saveEdit(event: React.FormEvent) {
    event.preventDefault();
    if (editingId === null || draftTitle.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await send("PATCH", {
        id: editingId,
        title: draftTitle.trim(),
        description: draftDescription.trim(),
      });
      setEditingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function removeGoal(goal: Goal) {
    setBusy(true);
    setError(null);
    try {
      await send("DELETE", undefined, `?id=${encodeURIComponent(goal.id)}`);
      if (editingId === goal.id) setEditingId(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const done = goals.filter((goal) => goal.status === "done").length;
  const percent = goals.length === 0 ? 0 : Math.round((done / goals.length) * 100);
  const selectableGoals = goals.filter((goal) => goal.status !== "done");
  const selectedGoals = selectableGoals.filter((goal) => selectedIds[goal.id]);

  function toggleSelectGoal(id: string) {
    setSelectedIds((current) => ({ ...current, [id]: !current[id] }));
  }

  async function sendSelectedToPlanAgent() {
    if (onSendGoalsToPlanAgent === undefined || selectedGoals.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await onSendGoalsToPlanAgent(
        selectedGoals.map((goal) => ({
          title: goal.title,
          description: goal.description,
          priority: goal.priority,
        })),
      );
      setNotice(`Sent ${selectedGoals.length} goal(s) to the plan agent.`);
      setSelectedIds({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card goals-section">
      <div className="project-card-head">
        <h2>Goals</h2>
        <span className="meta">
          {done}/{goals.length} complete
        </span>
      </div>

      <div className="bar">
        <div className="fill" style={{ width: `${percent}%` }} />
        <span className="bar-label">{percent}% of goals complete</span>
      </div>

      {loading && <p className="meta">Loading goals…</p>}
      {error !== null && <p className="notice bad">{error}</p>}
      {notice !== null && <p className="notice">{notice}</p>}

      {onSendGoalsToPlanAgent !== undefined && selectableGoals.length > 0 && (
        <div className="goal-plan-actions">
          <p className="meta">
            Goals read top to bottom: do the first one, then the next. Select goals and send them to
            the plan agent to turn them into tasks, in priority order.
          </p>
          <div className="row">
            <button
              type="button"
              onClick={() => void sendSelectedToPlanAgent()}
              disabled={busy || selectedGoals.length === 0}
            >
              {busy ? "Sending…" : "Send selected goals to plan agent"}
            </button>
            {selectedGoals.length > 0 && (
              <span className="meta">{selectedGoals.length} selected</span>
            )}
          </div>
        </div>
      )}

      {!loading && goals.length === 0 && (
        <p className="meta">No goals yet. Add the first one below.</p>
      )}

      <ol className="goal-list">
        {goals.map((goal, index) => (
          <li className={goal.status === "done" ? "goal-row done" : "goal-row"} key={goal.id}>
            {goal.status !== "done" && onSendGoalsToPlanAgent !== undefined && editingId !== goal.id && (
              <label className="goal-select">
                <input
                  type="checkbox"
                  checked={selectedIds[goal.id] === true}
                  onChange={() => toggleSelectGoal(goal.id)}
                  disabled={busy}
                  aria-label={`Select goal: ${goal.title}`}
                />
              </label>
            )}
            {editingId === goal.id ? (
              <form className="goal-edit" onSubmit={saveEdit}>
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  aria-label="Goal title"
                  autoFocus
                />
                <textarea
                  value={draftDescription}
                  onChange={(event) => setDraftDescription(event.target.value)}
                  aria-label="Goal description"
                  rows={2}
                />
                <div className="row">
                  <button className="primary" type="submit" disabled={busy}>
                    Save
                  </button>
                  <button type="button" onClick={() => setEditingId(null)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  className="goal-check"
                  onClick={() => void toggleGoal(goal)}
                  disabled={busy}
                  aria-label={goal.status === "done" ? "Mark as pending" : "Mark as done"}
                >
                  {goal.status === "done" ? "✓" : "○"}
                </button>
                <div className="goal-body">
                  <div className="goal-title">
                    <span className="goal-order">{index + 1}.</span> {goal.title}
                  </div>
                  {goal.description !== "" && <p className="goal-description">{goal.description}</p>}
                  <div className="goal-meta-row">
                    <label className="field goal-priority">
                      <span>Priority</span>
                      <select
                        value={goal.priority}
                        onChange={(event) =>
                          void setGoalPriority(goal, event.target.value as GoalPriority)
                        }
                        disabled={busy}
                        aria-label={`Priority for ${goal.title}`}
                      >
                        {PRIORITIES.map((entry) => (
                          <option key={entry} value={entry}>
                            {priorityLabel(entry)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
                <div className="row goal-actions">
                  <button
                    type="button"
                    onClick={() => void moveGoal(goal, "up")}
                    disabled={busy || index === 0}
                    aria-label={`Move ${goal.title} up`}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => void moveGoal(goal, "down")}
                    disabled={busy || index === goals.length - 1}
                    aria-label={`Move ${goal.title} down`}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button type="button" onClick={() => startEditing(goal)} disabled={busy}>
                    Edit
                  </button>
                  <button type="button" onClick={() => void removeGoal(goal)} disabled={busy}>
                    Delete
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ol>

      <form className="goal-form" onSubmit={addGoal}>
        <div className="label">Add a goal</div>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="What does done look like?"
          aria-label="New goal title"
        />
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Optional detail"
          aria-label="New goal description"
          rows={2}
        />
        <label className="field">
          <span>Priority</span>
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value as GoalPriority)}
            disabled={busy}
            aria-label="New goal priority"
          >
            {PRIORITIES.map((entry) => (
              <option key={entry} value={entry}>
                {priorityLabel(entry)}
              </option>
            ))}
          </select>
        </label>
        <button className="primary" type="submit" disabled={busy || title.trim() === ""}>
          Add goal
        </button>
      </form>
    </section>
  );
}
