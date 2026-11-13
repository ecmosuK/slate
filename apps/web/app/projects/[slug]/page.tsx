import { existsSync, readFileSync } from "node:fs";
import Link from "next/link";
import { notFound } from "next/navigation";

import { readProject } from "@slate/shared";

import ProjectWorkspace from "@/app/components/ProjectWorkspace";
import { decodeProjectSlug, projectFolder } from "@/lib/projects";

export const dynamic = "force-dynamic";

function percent(done: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
}

/** Prefer the first task that is actually open; the runner can start from it. */
function suggestedTask(project: ReturnType<typeof readProject>): string {
  const now = project.plan?.now.find((task) => !task.done);
  if (now !== undefined) return now.text;
  const next = project.plan?.next.find((task) => !task.done);
  if (next !== undefined) return next.text;
  return project.nextSteps[0] ?? "";
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
      <ProjectWorkspace
        slug={slug}
        folder={folder}
        suggestedTask={suggestedTask(project)}
        title={project.title ?? project.slug}
        status={project.status}
        milestone={project.milestone}
        source={project.source === "plan" ? "declared in the plan" : "inferred from README"}
        updatedAt={project.updatedAt}
        goal={project.goal}
        tasksDone={project.tasks.done}
        tasksTotal={project.tasks.total}
        plan={project.plan}
        taskItems={project.taskItems}
        nextSteps={project.nextSteps}
        warnings={project.warnings}
      />

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
