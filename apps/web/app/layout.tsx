import type { Metadata } from "next";

import { workspacesFor } from "@slate/shared";

import Lock from "./components/Lock";
import Sidebar from "./components/Sidebar";
import "./components/Sidebar.css";
import "./globals.css";
import { projects } from "../lib/projects";
import { loadStudio } from "../lib/session";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Slate",
  description: "Personal notes and project trackers that write READMEs and read agent plans back.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { state, identity } = await loadStudio();

  // A password stands between the app and the files; nothing else renders until it is entered.
  if (identity === null) {
    return (
      <html lang="en">
        <body>
          <Lock />
        </body>
      </html>
    );
  }

  const list = projects().map((project) => ({
    slug: project.slug,
    title: project.title,
    status: project.status,
    milestone: project.milestone,
  }));

  const workspaces = workspacesFor(state, identity.user.id).map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
  }));

  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <Sidebar
            projects={list}
            workspaces={workspaces}
            activeWorkspaceId={identity.workspace?.id ?? null}
            user={{ name: identity.user.name, email: identity.user.email }}
          />
          <div className="app-main">{children}</div>
        </div>
      </body>
    </html>
  );
}
