"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function NewProject() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [git, setGit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description, git }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string; slug?: string };
      if (!body.ok) throw new Error(body.error ?? "the project could not be created");
      setName("");
      setDescription("");
      setOpen(false);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        New project
      </button>
    );
  }

  return (
    <form className="card new-project" onSubmit={submit}>
      <h2>New project</h2>
      <label className="field">
        <span>Name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="budget tracker"
          autoFocus
        />
      </label>
      <label className="field">
        <span>One line about it</span>
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Tracks household spending"
        />
      </label>
      <label className="check">
        <input type="checkbox" checked={git} onChange={(event) => setGit(event.target.checked)} />
        <span>Start a git repository</span>
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={busy || name.trim() === ""}>
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error !== null && <p className="notice bad">{error}</p>}
    </form>
  );
}
