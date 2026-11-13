import Link from "next/link";

import { summarizePortfolio } from "@slate/shared";

import ProjectGrid from "./components/ProjectGrid";
import { projects } from "@/lib/projects";
import NewProject from "./new-project";

export const dynamic = "force-dynamic";

function percent(done: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((done / total) * 100);
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
        <ProjectGrid projects={list} />
      )}
    </main>
  );
}
