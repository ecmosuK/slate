import Link from "next/link";

import { summarizePortfolio } from "@slate/shared";

import { projects } from "@/lib/projects";
import NewProject from "./new-project";

export const dynamic = "force-dynamic";

function percent(done: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

function statusChip(status: string | null): string {
  if (status === "done") return "chip accent";
  if (status === "blocked") return "chip warn";
  return "chip";
}

export default function Home() {
  const list = projects();
  const rollup = summarizePortfolio(list);
  const overall = percent(rollup.tasksDone, rollup.tasksTotal);

  return (
    <main>
      <div className="topbar">
        <div>
          <h1>Projects</h1>
          <p className="subtitle">
            {rollup.projects} project{rollup.projects === 1 ? "" : "s"} · {rollup.tasksDone} of{" "}
            {rollup.tasksTotal} tasks done
            {rollup.blocked > 0 ? ` · ${rollup.blocked} blocked` : ""}
          </p>
        </div>
        <div className="row">
          <Link className="button-link" href="/chat">
            Ask the agent
          </Link>
          <Link className="button-link" href="/settings">
            Settings
          </Link>
          <NewProject />
        </div>
      </div>

      <div className="bar overall-bar">
        <div className="fill" style={{ width: `${overall}%` }} />
        <span className="bar-label">
          {overall}% overall · {rollup.withPlan} of {rollup.projects} with a plan
        </span>
      </div>

      {list.length === 0 ? (
        <div className="empty">
          No projects found. Create one, or check the projects root in Settings.
        </div>
      ) : (
        <div className="project-grid">
          {list.map((project) => {
            const done = percent(project.tasks.done, project.tasks.total);
            return (
              <Link className="card project-card" href={`/projects/${encodeURIComponent(project.slug)}`} key={project.slug}>
                <div className="project-card-head">
                  <h2>{project.title ?? project.slug}</h2>
                  {project.status !== null && (
                    <span className={statusChip(project.status)}>{project.status}</span>
                  )}
                </div>

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
            );
          })}
        </div>
      )}
    </main>
  );
}
