"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ProjectFolder } from "@/lib/projects";

function percent(done: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

function statusChip(status: string | null): string {
  if (status === "done") return "chip accent";
  if (status === "blocked") return "chip warn";
  return "chip";
}

export default function ProjectGrid({ projects }: { projects: ProjectFolder[] }) {
  const router = useRouter();
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function deleteProject(slug: string, title: string | null) {
    const label = title ?? slug;
    if (!window.confirm(`Delete project "${label}"? This will permanently remove its folder and files.`)) {
      return;
    }

    setBusySlug(slug);
    setError(null);
    try {
      const response = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, confirm: true }),
      });
      const body = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !body.ok) {
        throw new Error(body.error ?? `Could not delete project (${response.status})`);
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusySlug(null);
    }
  }

  return (
    <>
      {error !== null && <p className="notice bad">{error}</p>}
      <div className="project-grid">
        {projects.map((project) => {
          const done = percent(project.tasks.done, project.tasks.total);
          const deleting = busySlug === project.slug;
          return (
            <div className="card project-card project-card-container" key={project.slug}>
              <div className="project-card-head">
                <h2>
                  <Link className="project-card-link" href={`/projects/${encodeURIComponent(project.slug)}`}>
                    {project.title ?? project.slug}
                  </Link>
                </h2>
                <div className="project-card-head-actions">
                  {project.status !== null && (
                    <span className={statusChip(project.status)}>{project.status}</span>
                  )}
                  <button
                    type="button"
                    className="project-delete-button"
                    onClick={() => void deleteProject(project.slug, project.title ?? null)}
                    disabled={busySlug !== null}
                    aria-label={`Delete project ${project.title ?? project.slug}`}
                    title="Delete project"
                  >
                    {deleting ? "Deleting…" : "Delete"}
                  </button>
                </div>
              </div>

              <Link className="project-card-body-link" href={`/projects/${encodeURIComponent(project.slug)}`}>
                <p className="goal">{project.goal ?? "No goal written yet."}</p>

                <div className="meta">
                  <span>{project.source === "plan" ? "plan" : "inferred from README"}</span>
                  {project.milestone !== null && <span>· {project.milestone}</span>}
                  {project.updatedAt !== null && (
                    <span>· updated {new Date(project.updatedAt).toLocaleDateString()}</span>
                  )}
                </div>

                <div className="bar">
                  <div className="fill" style={{ width: `${done}%` }} />
                  <span className="bar-label">
                    {project.tasks.done}/{project.tasks.total} tasks · {done}%
                  </span>
                </div>

                {project.taskItems.length > 0 ? (
                  <ul className="task-preview">
                    {project.taskItems.slice(0, 4).map((task, index) => (
                      <li className={task.done ? "done" : ""} key={`${task.text}-${index}`}>
                        <span className="tick">{task.done ? "✓" : "○"}</span>
                        <span>{task.text}</span>
                      </li>
                    ))}
                    {project.taskItems.length > 4 && (
                      <li className="more">+{project.taskItems.length - 4} more in the project</li>
                    )}
                  </ul>
                ) : (
                  <ul className="task-preview">
                    {project.nextSteps.slice(0, 3).map((step, index) => (
                      <li key={`${step}-${index}`}>
                        <span className="tick">○</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Link>
            </div>
          );
        })}
      </div>
    </>
  );
}
