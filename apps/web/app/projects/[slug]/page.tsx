import { existsSync, readFileSync } from "node:fs";
import Link from "next/link";
import { notFound } from "next/navigation";

import { readProject, type PlanTask } from "@slate/shared";

import Goals from "@/app/components/Goals";
import { decodeProjectSlug, projectFolder } from "@/lib/projects";

export const dynamic = "force-dynamic";

function percent(done: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

function TaskList({ tasks }: { tasks: PlanTask[] }) {
  return (
    <ul className="tasks task-list">
      {tasks.map((task, index) => (
        <li className={task.done ? "done" : ""} key={`${task.text}-${index}`}>
          <span className="tick">{task.done ? "✓" : "○"}</span>
          <span>{task.text}</span>
        </li>
      ))}
    </ul>
  );
}

function TaskSection({ title, tasks }: { title: string; tasks: PlanTask[] }) {
  if (tasks.length === 0) return null;
  return (
    <div className="task-section">
      <div className="label">{title}</div>
      <TaskList tasks={tasks} />
    </div>
  );
}

export default async function ProjectPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: encodedSlug } = await params;
  const slug = decodeProjectSlug(encodedSlug);
  const folder = projectFolder(slug);
  if (folder === null || !existsSync(folder)) notFound();

  const project = readProject(folder, slug);
  const readme =
    project.readmePath === null ? "" : readFileSync(project.readmePath, "utf8");
  const done = percent(project.tasks.done, project.tasks.total);

  return (
    <main className="project-detail">
      <Link className="back-link" href="/">
        ← All projects
      </Link>

      <div className="topbar">
        <div>
          <h1>{project.title ?? project.slug}</h1>
          <div className="meta">
            {project.status !== null && <span className="chip">{project.status}</span>}
            {project.milestone !== null && <span className="chip accent">{project.milestone}</span>}
            <span>{project.source === "plan" ? "declared in the plan" : "inferred from README"}</span>
            {project.updatedAt !== null && (
              <span>· updated {new Date(project.updatedAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>
        <div className="row">
          <Link className="button-link" href={`/chat?project=${encodeURIComponent(slug)}`}>
            Ask the agent
          </Link>
          <Link className="button-link" href="/settings">
            Settings
          </Link>
        </div>
      </div>

      <section className="card">
        <div className="label">Goal</div>
        <p className="goal">{project.goal ?? "No goal written yet."}</p>
        <div className="bar">
          <div className="fill" style={{ width: `${done}%` }} />
          <span className="bar-label">
            {project.tasks.done}/{project.tasks.total} tasks done · {done}%
          </span>
        </div>
      </section>

      <div className="detail-grid">
        <section className="card">
          <h2>Tasks</h2>
          {project.plan !== null ? (
            <>
              <TaskSection title="Now" tasks={project.plan.now} />
              <TaskSection title="Next" tasks={project.plan.next} />
              <TaskSection title="Done" tasks={project.plan.done} />
            </>
          ) : project.taskItems.length > 0 ? (
            <TaskList tasks={project.taskItems} />
          ) : (
            <p className="meta">No tasks in this README yet.</p>
          )}
        </section>

        <section className="card">
          <h2>Next steps</h2>
          {project.nextSteps.length > 0 ? (
            <ul className="tasks">
              {project.nextSteps.map((step, index) => (
                <li key={`${step}-${index}`}>{step}</li>
              ))}
            </ul>
          ) : (
            <p className="meta">Nothing queued under a Next heading.</p>
          )}
          {project.warnings.length > 0 && (
            <div className="warnings">
              {project.warnings.map((warning) => (
                <p className="notice bad" key={warning}>
                  {warning}
                </p>
              ))}
            </div>
          )}
        </section>
      </div>

      <Goals slug={slug} />

      <section className="card">
        <h2>Full README</h2>
        {readme === "" ? (
          <p className="meta">This project has no README yet.</p>
        ) : (
          <pre className="readme-text">{readme}</pre>
        )}
      </section>
    </main>
  );
}
