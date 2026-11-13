"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export interface BannerButton {
  /** A stable key, used to remember whether the panel is open. */
  id: string;
  label: string;
  /** A short hint shown under the label. */
  hint?: string;
  open: boolean;
  onToggle: () => void;
}

export interface BannerProps {
  slug: string;
  title: string;
  status: string | null;
  milestone: string | null;
  source: string;
  updatedAt: string | null;
  /** The terminal and preview buttons, rendered on the right of the banner. */
  panels?: BannerButton[];
}

export default function ProjectBanner({
  slug,
  title,
  status,
  milestone,
  source,
  updatedAt,
  panels = [],
}: BannerProps) {
  // The banner is sticky, so it needs a solid background of its own.
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className={stuck ? "project-banner stuck" : "project-banner"}>
      <div className="project-banner-main">
        <Link className="back-link" href="/">
          ← All projects
        </Link>
        <div className="project-banner-title">
          <h1>{title}</h1>
          <div className="meta">
            {status !== null && <span className="chip">{status}</span>}
            {milestone !== null && <span className="chip accent">{milestone}</span>}
            <span>{source}</span>
            {updatedAt !== null && (
              <span>· updated {new Date(updatedAt).toLocaleDateString()}</span>
            )}
          </div>
        </div>
      </div>

      <div className="row project-banner-actions">
        {panels.map((panel) => (
          <button
            key={panel.id}
            type="button"
            className={panel.open ? "banner-panel-button open" : "banner-panel-button"}
            onClick={panel.onToggle}
            aria-expanded={panel.open}
            title={panel.hint ?? panel.label}
          >
            <span className="banner-panel-dot" aria-hidden="true" />
            {panel.label}
          </button>
        ))}
        <Link className="button-link" href={`/chat?project=${encodeURIComponent(slug)}`}>
          Ask the agent
        </Link>
        <Link className="button-link" href="/settings">
          Settings
        </Link>
      </div>
    </div>
  );
}
