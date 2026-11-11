"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SidebarProject {
  slug: string;
  title: string | null;
  status: string | null;
  milestone: string | null;
}

interface SidebarProps {
  projects: SidebarProject[];
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function Sidebar({ projects }: SidebarProps) {
  const pathname = usePathname() ?? "/";
  const activeSlug = pathname.startsWith("/projects/")
    ? decodeURIComponent(pathname.slice("/projects/".length))
    : null;

  return (
    <aside className="sidebar">
      <Link className="sidebar-brand" href="/">
        Slate
      </Link>

      <nav className="sidebar-nav" aria-label="Main">
        <Link className={isActive(pathname, "/chat") ? "sidebar-link active" : "sidebar-link"} href="/chat">
          Agent
        </Link>
        <Link
          className={isActive(pathname, "/calendar") ? "sidebar-link active" : "sidebar-link"}
          href="/calendar"
        >
          Calendar
        </Link>
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-heading">
          <span>Projects</span>
          <span className="sidebar-count">{projects.length}</span>
        </div>
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.slug}>
              <Link
                className={
                  activeSlug === project.slug ? "project-item active" : "project-item"
                }
                href={`/projects/${encodeURIComponent(project.slug)}`}
                title={project.milestone ?? undefined}
              >
                <span className="project-name">{project.title ?? project.slug}</span>
                {project.status !== null && <span className="project-status">{project.status}</span>}
              </Link>
            </li>
          ))}
        </ul>
        {projects.length === 0 && <p className="sidebar-empty">No projects yet.</p>}
      </div>

      <div className="sidebar-section sidebar-future">
        <div className="sidebar-heading">
          <span>More</span>
        </div>
        <span className="sidebar-future-item">Notes</span>
        <span className="sidebar-future-item">Requests</span>
      </div>

      <div className="sidebar-footer">
        <Link
          className={isActive(pathname, "/settings") ? "sidebar-link active" : "sidebar-link"}
          href="/settings"
        >
          Settings
        </Link>
      </div>
    </aside>
  );
}
