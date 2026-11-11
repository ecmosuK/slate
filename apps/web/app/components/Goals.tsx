"use client";

import { useEffect, useState } from "react";

type GoalStatus = "pending" | "done";

interface Goal {
  id: string;
  title: string;
  description: string;
  status: GoalStatus;
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

export default function Goals({ slug }: { slug: string }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftDescription, setDraftDescription] = useState("");

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
  }, [slug]);

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
      await send("POST", { title: title.trim(), description: description.trim() });
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

      {!loading && goals.length === 0 && (
        <p className="meta">No goals yet. Add the first one below.</p>
      )}

      <ul className="goal-list">
        {goals.map((goal) => (
          <li className={goal.status === "done" ? "goal-row done" : "goal-row"} key={goal.id}>
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
                  <div className="goal-title">{goal.title}</div>
                  {goal.description !== "" && <p className="goal-description">{goal.description}</p>}
                </div>
                <div className="row goal-actions">
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
      </ul>

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
        <button className="primary" type="submit" disabled={busy || title.trim() === ""}>
          Add goal
        </button>
      </form>
    </section>
  );
}
