import { listProjects, PROJECTS_ROOT } from "../lib/projects";

export const dynamic = "force-dynamic";

export default function Home() {
  const projects = listProjects();

  return (
    <main>
      <h1>Slate</h1>
      <p className="subtitle">
        Projects under <code>{PROJECTS_ROOT}</code>
      </p>

      {projects.length === 0 ? (
        <div className="empty">No projects found in the projects root.</div>
      ) : (
        projects.map((project) => {
          const plan = project.plan;
          const openRequests = project.requests.filter((request) => !request.done).length;

          return (
            <article className="card" key={project.slug}>
              <h2>{project.slug}</h2>
              <div className="meta">
                {plan === null ? (
                  <>
                    <span className="chip warn">no plan</span>
                    {project.planError !== null && <span>{project.planError}</span>}
                  </>
                ) : (
                  <>
                    <span className="chip accent">{plan.status}</span>
                    {plan.milestone !== undefined && <span className="chip">{plan.milestone}</span>}
                    <span>
                      {plan.now.filter((task) => task.done).length}/{plan.now.length} in Now
                    </span>
                    <span>{plan.agent}</span>
                    <span>updated {plan.updated.slice(0, 10)}</span>
                    {project.staleness !== null && project.staleness !== "fresh" && (
                      <span className="chip warn">{project.staleness}</span>
                    )}
                  </>
                )}
                {openRequests > 0 && <span className="chip">{openRequests} request(s)</span>}
              </div>

              {plan !== null && (
                <>
                  {plan.goal !== "" && <p className="goal">{plan.goal}</p>}
                  {plan.now.length > 0 && (
                    <ul className="tasks">
                      {plan.now.map((task) => (
                        <li className={task.done ? "done" : undefined} key={task.text}>
                          {task.text}
                        </li>
                      ))}
                    </ul>
                  )}
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
