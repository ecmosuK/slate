"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Remember whether a floating panel is open.
 *
 * The banner button and the panel itself share this state, so opening from one and closing from
 * the other stay in step, and the choice survives a reload.
 */
export function useDockState(id: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`slate:dock:${id}`);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as { open?: unknown };
      if (typeof parsed.open === "boolean") setOpen(parsed.open);
    } catch {
      // Storage may be unavailable; the panel still works for this visit.
    }
  }, [id]);

  const set = useCallback(
    (next: boolean) => {
      setOpen(next);
      try {
        window.localStorage.setItem(`slate:dock:${id}`, JSON.stringify({ open: next }));
      } catch {
        // Storage may be unavailable; the panel still works for this visit.
      }
    },
    [id],
  );

  return [open, set];
}
