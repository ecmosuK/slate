"use client";

import { useMemo, useState } from "react";

import type { PlanTask } from "@slate/shared";

export interface SelectableTaskItem {
  id: string;
  text: string;
  section: string;
  done: boolean;
}

/** The plan and fallback task list a project shows. */
export interface ProjectTasks {
  plan: { now: PlanTask[]; next: PlanTask[]; done: PlanTask[] } | null;
  taskItems: PlanTask[];
}

function TaskRow({
  task,
  selectable,
  selected,
  onToggle,
  onDelete,
}: {
  task: { text: string; done: boolean; id?: string; section?: string };
  selectable: boolean;
  selected: boolean;
  onToggle?: (id: string) => void;
  onDelete?: (task: { text: string; section: string }) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function remove() {
    if (onDelete === undefined) return;
    setBusy(true);
    try {
      await onDelete({ text: task.text, section: task.section ?? "now" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={task.done ? "done" : ""}>
      {selectable && task.id !== undefined && onToggle !== undefined ? (
        <label className="task-select-inline">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle(task.id as string)}
            aria-label={`Select task: ${task.text}`}
          />
          <span className="tick">{task.done ? "✓" : "○"}</span>
          <span>{task.text}</span>
        </label>
      ) : (
        <>
          <span className="tick">{task.done ? "✓" : "○"}</span>
          <span>{task.text}</span>
        </>
      )}
      {onDelete !== undefined && (
        <button
          type="button"
          className="task-delete"
          onClick={() => void remove()}
          disabled={busy}
          aria-label={`Delete task: ${task.text}`}
          title="Delete this task"
        >
          Delete
        </button>
      )}
    </li>
  );
}

function Section({
  title,
  tasks,
  selectable = false,
  selectedIds,
  onToggle,
  onDelete,
  collapsible = false,
  defaultCollapsed = false,
}: {
  title: string;
  tasks: SelectableTaskItem[];
  selectable?: boolean;
  selectedIds?: Record<string, boolean>;
  onToggle?: (id: string) => void;
  onDelete?: (task: { text: string; section: string }) => void;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  if (tasks.length === 0) return null;

  return (
    <div className="task-section">
      <div className="label task-section-label">
        <span>{title}</span>
        {collapsible && (
          <button
            type="button"
            className="task-collapse-button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
          >
            {collapsed ? `Show (${tasks.length})` : "Minimize"}
          </button>
        )}
      </div>
      {!collapsed && (
        <ul className="tasks task-list">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              selectable={selectable && !task.done}
              selected={selectedIds?.[task.id] === true}
              onToggle={onToggle}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default function ProjectTasksCard({
  plan,
  taskItems,
  selectedIds,
  onToggle,
  onSelectAll,
  onClearSelection,
  onDelete,
}: {
  plan: ProjectTasks["plan"];
  taskItems: PlanTask[];
  selectedIds: Record<string, boolean>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDelete?: (task: { text: string; section: string }) => Promise<void>;
}) {
  const sections = useMemo(() => {
    const current = plan;
    // The id is the section and the text, not the position, so a selection survives another
    // task being added or removed.
    if (current !== null) {
      return {
        now: current.now.map((task) => ({
          id: `now:${task.text}`,
          text: task.text,
          section: "Now",
          done: task.done,
        })),
        next: current.next.map((task) => ({
          id: `next:${task.text}`,
          text: task.text,
          section: "Next",
          done: task.done,
        })),
        done: current.done.map((task) => ({
          id: `done:${task.text}`,
          text: task.text,
          section: "Done",
          done: task.done,
        })),
      };
    }
    const mapped = taskItems.map((task) => ({
      id: `task:${task.text}`,
      text: task.text,
      section: task.done ? "Done" : "Task",
      done: task.done,
    }));
    return {
      now: mapped.filter((t) => !t.done),
      next: [] as SelectableTaskItem[],
      done: mapped.filter((t) => t.done),
    };
  }, [plan, taskItems]);

  const selectableCount =
    sections.now.filter((t) => !t.done).length + sections.next.filter((t) => !t.done).length;
  const selectedCount = Object.values(selectedIds).filter(Boolean).length;

  const hasAny = sections.now.length + sections.next.length + sections.done.length > 0;

  return (
    <>
      <div className="project-card-head">
        <h2>Tasks</h2>
        {selectableCount > 0 && (
          <span className="meta">
            {selectedCount}/{selectableCount} selected
          </span>
        )}
      </div>
      {selectableCount > 0 && (
        <div className="row task-select-actions">
          <button type="button" onClick={onSelectAll} disabled={selectedCount === selectableCount}>
            Select all
          </button>
          <button type="button" onClick={onClearSelection} disabled={selectedCount === 0}>
            Clear selection
          </button>
        </div>
      )}
      {!hasAny ? (
        <p className="meta">No tasks in this README yet.</p>
      ) : (
        <div className="project-tasks-body">
          <Section
            title="Now"
            tasks={sections.now}
            selectable
            selectedIds={selectedIds}
            onToggle={onToggle}
            onDelete={onDelete}
          />
          <Section
            title="Next"
            tasks={sections.next}
            selectable
            selectedIds={selectedIds}
            onToggle={onToggle}
            onDelete={onDelete}
          />
          <Section
            title="Done"
            tasks={sections.done}
            collapsible
            defaultCollapsed={sections.done.length > 5}
            onDelete={onDelete}
          />
        </div>
      )}
    </>
  );
}
