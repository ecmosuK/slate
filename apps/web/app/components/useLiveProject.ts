"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { PlanTask } from "@slate/shared";

export interface LivePlan {
  plan: { now: PlanTask[]; next: PlanTask[]; done: PlanTask[] } | null;
  taskItems: PlanTask[];
  nextSteps: string[];
  warnings: string[];
}

interface PlanResponse {
  ok: boolean;
  signature?: string | null;
  plan?: LivePlan["plan"];
  taskItems?: PlanTask[];
  nextSteps?: string[];
  warnings?: string[];
  error?: string;
}

/**
 * Keep a project's plan in step with the disk.
 *
 * The plan agent, the task runner and the terminal all change a project from outside the page,
 * so the page polls for the current state. `refresh()` forces an immediate check, so a change
 * the user just made shows up at once instead of after the next tick.
 */
export function useLiveProject(
  slug: string,
  initial: LivePlan,
  intervalMs = 3000,
): { live: LivePlan; refresh: () => void } {
  const [live, setLive] = useState<LivePlan>(initial);
  const signature = useRef<string | null>(null);
  const inFlight = useRef(false);

  // Adopt the server-rendered values when they change (a navigation or a re-render).
  useEffect(() => {
    setLive(initial);
  }, [initial]);

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(slug)}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = (await response.json()) as PlanResponse;
      if (!body.ok) return;

      const next = body.signature ?? null;
      // The first poll only records the signature; the page is already current.
      if (next !== null && signature.current === null) {
        signature.current = next;
        setLive({
          plan: body.plan ?? null,
          taskItems: body.taskItems ?? [],
          nextSteps: body.nextSteps ?? [],
          warnings: body.warnings ?? [],
        });
        return;
      }
      if (next !== null && next === signature.current) return;
      signature.current = next;

      setLive({
        plan: body.plan ?? null,
        taskItems: body.taskItems ?? [],
        nextSteps: body.nextSteps ?? [],
        warnings: body.warnings ?? [],
      });
    } catch {
      // A poll failure is not fatal; the next tick retries.
    } finally {
      inFlight.current = false;
    }
  }, [slug]);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), intervalMs);
    return () => window.clearInterval(timer);
  }, [poll, intervalMs]);

  const refresh = useCallback(() => void poll(), [poll]);

  return { live, refresh };
}
