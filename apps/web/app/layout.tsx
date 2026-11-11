import type { Metadata } from "next";

import Sidebar from "./components/Sidebar";
import "./components/Sidebar.css";
import "./globals.css";
import { projects } from "../lib/projects";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Slate",
  description: "Personal notes and project trackers that write READMEs and read agent plans back.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const list = projects().map((project) => ({
    slug: project.slug,
    title: project.title,
    status: project.status,
    milestone: project.milestone,
  }));

  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <Sidebar projects={list} />
          <div className="app-main">{children}</div>
        </div>
      </body>
    </html>
  );
}
