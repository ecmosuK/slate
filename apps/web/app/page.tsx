import Link from "next/link";
import { summarizePortfolio } from "@slate/shared";

import NewProject from "./new-project";
import { projects, projectsRoot } from "../lib/projects";

export const dynamic = "force-dynamic";

function percent(done: number, total: number): number {
  return total === 0 ? 0 : Math.round((done / total) * 100);
}

function shortAge(iso: string | null): string {
  if (iso === null) return "unknown";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function Home() {
  const list = projects();
  const rollup = summarizePortfolio(list);

  return (
    <main>
      <div className="topbar">
        <div>
          <h1>Slate</h1>
          <p className="subtitle">
            {rollup.projects} project(s) under <code>{projectsRoot()}</code> · {rollup.withPlan}{" "}
            with a plan block · {rollup.tasksDone} of {rollup.tasksTotal} tasks done
            {rollup.blocked > 0 ? ` · ${rollup.blocked} blocked` : ""}
          </p>
        </div>
        <div className="row">
          <NewProject />
          <Link className="button-link" href="/settings">
            Settings
          </Link>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="empty">No projects found in the projects root.</div>
      ) : (
        list.map((project) => {
          const { done, total } = project.tasks;
          const pct = percent(done, total);

          return (
            <article className="card" key={project.slug}>
              <h2>{project.title ?? project.slug}</h2>

              <div className="meta">
                {project.status !== null && <span className="chip accent">{project.status}</span>}
                {project.milestone !== null && <span className="chip">{project.milestone}</span>}
                <span className={project.source === "plan" ? "chip" : "chip warn"}>
                  {project.source === "plan" ? "plan block" : project.source}
                </span>
                {project.updatedAt !== null && <span>updated {shortAge(project.updatedAt)}</span>}
                {project.git !== null && project.git.branch !== null && (
                  <span>
                    <code>{project.git.branch}</code>
                    {project.git.shortSha !== null && ` ${project.git.shortSha.slice(0, 7)}`}
                    {project.git.dirty ? " · dirty" : ""}
                  </span>
                )}
              </div>

              {total > 0 && (
                <div className="bar" title={`${done} of ${total} tasks done`}>
                  <div className="fill" style={{ width: `${pct}%` }} />
                  <span className="bar-label">
                    {done}/{total} tasks
                  </span>
                </div>
              )}

              {project.goal !== null && <p className="goal">{project.goal}</p>}

              {project.nextSteps.length > 0 && (
                <>
                  <p className="label">Next</p>
                  <ul className="tasks">
                    {project.nextSteps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ul>
                </>
              )}

              {project.warnings.length > 0 && (
                <div className="meta">
                  {project.warnings.map((warning) => (
                    <span className="chip warn" key={warning}>
                      {warning}
                    </span>
                  ))}
                </div>
              )}
            </article>
          );
        })
      )}
    </main>
  );
}
