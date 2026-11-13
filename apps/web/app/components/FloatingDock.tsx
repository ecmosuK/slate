"use client";

import { useCallback, useEffect, type ReactNode } from "react";

export interface FloatingDockProps {
  title: string;
  /** A short line under the title, e.g. the session's command. */
  subtitle?: string;
  /** Shown as a dot on the panel. */
  status?: "idle" | "running" | "error";
  /** Where the dock sits when several are open. */
  stack?: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * A floating panel in the top right of the window.
 *
 * It sits over the page rather than in the flow, so it overlaps the planning and building
 * sections instead of pushing them down.
 *
 * The button in the banner is the only way in and out: opening shows the panel, and minimising
 * closes it again. There is deliberately no second button beside the panel, so the panel never
 * leaves a duplicate of the one that opened it.
 */
export default function FloatingDock({
  title,
  subtitle,
  status = "idle",
  stack = 0,
  open,
  onOpenChange,
  children,
}: FloatingDockProps) {
  const close = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // Escape puts the panel away.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <section
      className="floating-dock"
      style={{ top: `${12 + stack * 38}px` }}
      aria-label={title}
    >
      <header className="floating-dock-head">
        <div className="floating-dock-title">
          <span className={`floating-dock-dot status-${status}`} aria-hidden="true" />
          <strong>{title}</strong>
          {subtitle !== undefined && subtitle !== "" && (
            <span className="floating-dock-subtitle">{subtitle}</span>
          )}
        </div>
        <button
          type="button"
          className="floating-dock-button"
          onClick={close}
          aria-label={`Minimise ${title}`}
          title="Minimise"
        >
          –
        </button>
      </header>
      <div className="floating-dock-body">{children}</div>
    </section>
  );
}
