"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { PlanTask } from "@slate/shared";

import FloatingDock from "./FloatingDock";
import Goals from "./Goals";
import PlanAndQueuePanel, { type PlanAndQueueHandle } from "./PlanAndQueuePanel";
import PreviewPane from "./PreviewPane";
import ProjectBanner from "./ProjectBanner";
import ProjectTasksCard from "./ProjectTasksCard";
import TaskDispatch, { type DispatchMode } from "./TaskDispatch";
import TaskRunner from "./TaskRunner";
import TerminalPane from "./TerminalPane";
import { useDockState } from "./useDockState";
import { useLiveProject } from "./useLiveProject";
import { DEFAULT_JOB_MODEL } from "@/lib/job-defaults";
import { terminalPreview } from "@/lib/preview-port";

export interface WorkspaceTask {
  id: string;
  text: string;
  section: string;
  done: boolean;
}

export default function ProjectWorkspace({
  slug,
  folder,
  suggestedTask,
  title,
  status,
  milestone,
  source,
  updatedAt,
  goal,
  tasksDone,
  tasksTotal,
  plan,
  taskItems,
  nextSteps,
  warnings,
}: {
  slug: string;
  folder: string;
  suggestedTask: string;
  title: string;
  status: string | null;
  milestone: string | null;
  source: string;
  updatedAt: string | null;
  goal: string | null;
  tasksDone: number;
  tasksTotal: number;
  plan: { now: PlanTask[]; next: PlanTask[]; done: PlanTask[] } | null;
  taskItems: PlanTask[];
  nextSteps: string[];
  warnings: string[];
}) {
  const planRef = useRef<PlanAndQueueHandle | null>(null);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [panelNotice, setPanelNotice] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [mode, setMode] = useState<DispatchMode>("build");
  const [model, setModel] = useState(DEFAULT_JOB_MODEL);

  // The floating panes live in the top right of the window and overlap the page. The banner
  // button is the only way in and out, so the pane never leaves a duplicate button behind.
  const [terminalOpen, setTerminalOpen] = useDockState("terminal");
  const [previewOpen, setPreviewOpen] = useDockState("preview");
  const [terminalSession, setTerminalSession] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState("");
  /** The server the terminal announced. The preview exists only while this is non-null. */
  const preview = useMemo(() => terminalPreview(terminalOutput), [terminalOutput]);

  // The plan agent, the task runner and the terminal all change the project from outside the
  // page, so the page keeps its own copy in step with what is on disk.
  const initial = useMemo(
    () => ({ plan, taskItems, nextSteps, warnings }),
    [plan, taskItems, nextSteps, warnings],
  );
  const { live, refresh } = useLiveProject(slug, initial);

  // The goals list is fetched by its own component; a bump makes it reload.
  const [goalsRefresh, setGoalsRefresh] = useState(0);
  const refreshAll = useCallback(() => {
    refresh();
    setGoalsRefresh((current) => current + 1);
  }, [refresh]);

  const allTasks: WorkspaceTask[] = useMemo(() => {
    if (live.plan !== null) {
      return [
        ...live.plan.now.map((task) => ({
          id: `now:${task.text}`,
          text: task.text,
          section: "Now",
          done: task.done,
        })),
        ...live.plan.next.map((task) => ({
          id: `next:${task.text}`,
          text: task.text,
          section: "Next",
          done: task.done,
        })),
        ...live.plan.done.map((task) => ({
          id: `done:${task.text}`,
          text: task.text,
          section: "Done",
          done: task.done,
        })),
      ];
    }
    return live.taskItems.map((task) => ({
      id: `task:${task.text}`,
      text: task.text,
      section: task.done ? "Done" : "Task",
      done: task.done,
    }));
  }, [live]);

  const selectableTasks = allTasks.filter((task) => !task.done);
  const selectedTasks = selectableTasks.filter((task) => selectedIds[task.id]);

  function toggleTask(id: string) {
    setSelectedIds((current) => ({ ...current, [id]: !current[id] }));
  }

  function selectAllTasks() {
    const next: Record<string, boolean> = {};
    for (const task of selectableTasks) next[task.id] = true;
    setSelectedIds(next);
  }

  function clearTaskSelection() {
    setSelectedIds({});
  }

  async function deleteTask(task: { text: string; section: string }): Promise<void> {
    const section = task.section.toLowerCase();
    const response = await fetch(`/api/projects/${encodeURIComponent(slug)}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", section, task: task.text }),
    });
    const body = (await response.json()) as { ok: boolean; error?: string };
    if (!response.ok || !body.ok) {
      const message = body.error ?? "The task could not be removed.";
      setPanelError(message);
      throw new Error(message);
    }
    // Drop it from the selection, then re-read the plan.
    setSelectedIds((current) => {
      const next = { ...current };
      delete next[`${section}:${task.text}`];
      return next;
    });
    refreshAll();
  }

  async function sendTasksToPlanBot() {
    setPanelNotice(null);
    setPanelError(null);
    if (selectedTasks.length === 0) {
      setPanelError("Select at least one task in the Tasks section to send to the plan agent.");
      throw new Error("Select at least one task in the Tasks section to send to the plan agent.");
    }
    if (planRef.current === null) {
      const message = "The plan agent is not ready yet.";
      setPanelError(message);
      throw new Error(message);
    }
    const lines = selectedTasks.map((task) => `- [${task.section}] ${task.text}`).join("\n");
    const message = `Selected tasks:\n${lines}\n\nI want to workshop this idea. What are you unsure about?`;
    await planRef.current.sendToPlanAgent(message);
    setPanelNotice(`Sent ${selectedTasks.length} task(s) to the plan agent.`);
  }

  async function sendTasksToRun() {
    setPanelNotice(null);
    setPanelError(null);
    if (selectedTasks.length === 0) {
      setPanelError("Select at least one task in the Tasks section to send to Run a task.");
      throw new Error("Select at least one task in the Tasks section to send to Run a task.");
    }
    if (planRef.current === null) {
      const message = "The run queue is not ready yet.";
      setPanelError(message);
      throw new Error(message);
    }
    const result = await planRef.current.sendTasksToRun(
      selectedTasks.map((task) => task.text),
      mode,
      model,
    );
    if (result.notice) setPanelNotice(result.notice);
    if (result.error) {
      setPanelError(result.error);
      throw new Error(result.error);
    }
    clearTaskSelection();
  }

  async function sendGoalsToPlanBot(
    goals: { title: string; description: string; priority: string }[],
  ) {
    setPanelNotice(null);
    setPanelError(null);
    if (planRef.current === null) {
      setPanelError("The plan agent is not ready yet.");
      return;
    }
    const lines = goals
      .map(
        (g) =>
          `- ${g.title} (priority: ${g.priority})${g.description ? ` — ${g.description}` : ""}`,
      )
      .join("\n");
    const message = `Selected goals to turn into tasks, in this order:\n${lines}\n\nI want to workshop this idea. What are you unsure about? Please help turn these goals into concrete tasks and add them to the project plan when ready, highest priority first.`;
    await planRef.current.sendToPlanAgent(message);
    setPanelNotice(`Sent ${goals.length} goal(s) to the plan agent.`);
  }

  /** The terminal pane's output, so the preview can look for a dev-server port in it. */
  const onTerminalOutput = useCallback((text: string) => {
    setTerminalOutput((current) => `${current}${text}`.slice(-20_000));
  }, []);

  /** A new terminal session starts with a clean slate; its output decides the preview port. */
  const onTerminalSessionChange = useCallback((id: string | null) => {
    setTerminalSession(id);
    setTerminalOutput("");
  }, []);

  /** The server process ended, so its port is gone and the preview goes with it. */
  const onTerminalSessionEnd = useCallback(() => {
    setTerminalOutput("");
  }, []);

  // The preview is only a view of the terminal server. If the terminal stops announcing a port,
  // put the pane away; the terminal process itself is never touched from here.
  useEffect(() => {
    if (preview === null && previewOpen) setPreviewOpen(false);
  }, [preview, previewOpen, setPreviewOpen]);


  const bannerPanels = [
    {
      id: "terminal",
      label: "Terminal",
      hint: "Run commands in this project",
      open: terminalOpen,
      onToggle: () => setTerminalOpen(!terminalOpen),
    },
    // The preview button only exists once the terminal has announced a server. There is nothing
    // to frame, and Slate never starts a server of its own, before that.
    ...(preview === null
      ? []
      : [
          {
            id: "preview",
            label: "Preview",
            hint: `See the server on port ${preview.port}`,
            open: previewOpen,
            onToggle: () => setPreviewOpen(!previewOpen),
          },
        ]),
  ];

  return (
    <>
      <ProjectBanner
        slug={slug}
        title={title}
        status={status}
        milestone={milestone}
        source={source}
        updatedAt={updatedAt}
        panels={bannerPanels}
      />

      <section className="card">
        <div className="label">Goal</div>
        <p className="goal">{goal ?? "No goal written yet."}</p>
        <div className="bar">
          <div
            className="fill"
            style={{
              width: `${tasksTotal === 0 ? 0 : Math.round((tasksDone / tasksTotal) * 100)}%`,
            }}
          />
          <span className="bar-label">
            {tasksDone}/{tasksTotal} tasks done
          </span>
        </div>
      </section>

      <FloatingDock
        title="Terminal"
        subtitle={slug}
        status={terminalOpen ? "running" : "idle"}
        stack={0}
        open={terminalOpen}
        onOpenChange={setTerminalOpen}
      >
        <TerminalPane
          slug={slug}
          sessionId={terminalSession}
          onSessionChange={onTerminalSessionChange}
          onSessionEnd={onTerminalSessionEnd}
          onOutput={onTerminalOutput}
        />
      </FloatingDock>

      {preview !== null && (
        <FloatingDock
          title="Preview"
          subtitle={`port ${preview.port}`}
          status="running"
          stack={1}
          open={previewOpen}
          onOpenChange={setPreviewOpen}
        >
          <PreviewPane port={preview.port} />
        </FloatingDock>
      )}

      <div className="project-top-grid">
        <section className="card">
          <ProjectTasksCard
            plan={live.plan}
            taskItems={live.taskItems}
            selectedIds={selectedIds}
            onToggle={toggleTask}
            onSelectAll={selectAllTasks}
            onClearSelection={clearTaskSelection}
            onDelete={deleteTask}
          />
        </section>

        <section className="card">
          <h2>Next steps</h2>
          <div className="project-next-body">
            {live.nextSteps.length > 0 ? (
              <ul className="tasks">
                {live.nextSteps.map((step, index) => (
                  <li key={`${step}-${index}`}>{step}</li>
                ))}
              </ul>
            ) : (
              <p className="meta">Nothing queued under a Next heading.</p>
            )}
            {live.warnings.length > 0 && (
              <div className="warnings">
                {live.warnings.map((warning) => (
                  <p className="notice bad" key={warning}>
                    {warning}
                  </p>
                ))}
              </div>
            )}
          </div>
        </section>

        <TaskDispatch
          selectedCount={selectedTasks.length}
          mode={mode}
          model={model}
          onModeChange={setMode}
          onModelChange={setModel}
          onSendToPlanBot={sendTasksToPlanBot}
          onSendToRun={sendTasksToRun}
          onClearSelection={clearTaskSelection}
        />
      </div>

      <Goals
        slug={slug}
        onSendGoalsToPlanAgent={sendGoalsToPlanBot}
        refreshSignal={goalsRefresh}
      />

      <PlanAndQueuePanel ref={planRef} slug={slug} onChanged={refreshAll} />

      <TaskRunner slug={slug} folder={folder} suggestedTask={suggestedTask} />

      {panelNotice !== null && <p className="notice">{panelNotice}</p>}
      {panelError !== null && <p className="notice bad">{panelError}</p>}
    </>
  );
}
