"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface SwitcherWorkspace {
  id: string;
  name: string;
}

interface WorkspaceSwitcherProps {
  workspaces: SwitcherWorkspace[];
  activeId: string | null;
}

/**
 * The workspace on screen. Switching and creating both end with `router.refresh()`, so the sidebar
 * and the pages behind it are re-read from the server instead of kept in two places.
 */
export default function WorkspaceSwitcher({ workspaces, activeId }: WorkspaceSwitcherProps) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send(body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!payload.ok) throw new Error(payload.error ?? "the workspace could not be saved");
      setName("");
      setCreating(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function select(id: string): Promise<void> {
    if (id === "" || id === activeId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/workspaces", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, active: true }),
      });
      const payload = (await response.json()) as { ok: boolean; error?: string };
      if (!payload.ok) throw new Error(payload.error ?? "the workspace could not be opened");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function create(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await send({ name });
  }

  return (
    <div className="workspace-switcher">
      <div className="sidebar-heading">
        <span>Workspace</span>
      </div>
      <div className="workspace-row">
        <select
          aria-label="Workspace"
          value={activeId ?? ""}
          disabled={busy}
          onChange={(event) => void select(event.target.value)}
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="workspace-add"
          aria-label="New workspace"
          title="New workspace"
          disabled={busy}
          onClick={() => setCreating((open) => !open)}
        >
          +
        </button>
      </div>

      {creating && (
        <form className="workspace-form" onSubmit={(event) => void create(event)}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Workspace name"
            aria-label="Workspace name"
            autoFocus
            maxLength={60}
          />
          <button type="submit" disabled={busy || name.trim() === ""}>
            Add
          </button>
        </form>
      )}

      {error !== null && <p className="workspace-error">{error}</p>}
    </div>
  );
}
