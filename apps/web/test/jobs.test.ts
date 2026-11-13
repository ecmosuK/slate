import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cancelJob,
  deleteJob,
  getJob,
  listJobs,
  reconcileJobs,
  setJobBinaryResolver,
  setJobFolderResolver,
  setJobKill,
  setJobSpawn,
  startJob,
  type JobSpawn,
} from "@/lib/jobs";

/** A stand-in for a spawned opencode process. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }

  /** Pretend the process finished. */
  finish(code: number | null = 0): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code, null);
  }
}

let root: string;
let projectFolder: string;
let spawned: FakeChild[];
let spawnCalls: { command: string; args: readonly string[] }[];
let counter = 0;

/** The job store is global, so every test uses its own project name. */
function nextProject(): string {
  counter += 1;
  const name = `demo-${counter}`;
  mkdirSync(join(root, name), { recursive: true });
  return name;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slate-jobs-"));
  projectFolder = join(root, "demo");
  mkdirSync(projectFolder, { recursive: true });
  spawned = [];
  spawnCalls = [];

  setJobFolderResolver((slug) => join(root, slug));
  setJobBinaryResolver(() => "/fake/opencode");

  const fakeSpawn: JobSpawn = (command, args) => {
    spawnCalls.push({ command, args });
    const child = new FakeChild();
    spawned.push(child);
    return child as unknown as ReturnType<JobSpawn>;
  };
  setJobSpawn(fakeSpawn);
  setJobKill((child) => {
    if (child === null) return;
    (child as unknown as FakeChild).kill();
  });
});

afterEach(() => {
  setJobSpawn(null);
  setJobFolderResolver(null);
  setJobBinaryResolver(null);
  setJobKill(null);
  rmSync(root, { recursive: true, force: true });
});

describe("startJob", () => {
  it("starts the process and reports a running job", () => {
    const project = nextProject();
    const job = startJob({ project, task: "do the thing", mode: "build" });

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toBe("/fake/opencode");
    expect(job.status).toBe("running");
    expect(job.startedAt).not.toBeNull();
    expect(job.endedAt).toBeNull();
  });

  it("writes a start line into the log", () => {
    const project = nextProject();
    const job = startJob({ project, task: "do the thing", mode: "build" });

    const detail = getJob(job.id);
    expect(detail?.log).toContain("— starting task");
  });

  it("records the output of the process", async () => {
    const project = nextProject();
    const job = startJob({ project, task: "do the thing", mode: "build" });
    const child = spawned[0];
    expect(child).toBeDefined();

    child?.stdout.write(`${JSON.stringify({ type: "text", part: { text: "Hi!" } })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(getJob(job.id)?.log).toContain("Hi!");
  });

  it("queues a second job and promotes it when the first finishes", () => {
    const project = nextProject();
    const first = startJob({ project, task: "first", mode: "build" });
    expect(first.status).toBe("running");

    const second = startJob({ project, task: "second", mode: "build" });
    expect(second.status).toBe("queued");
    expect(spawnCalls).toHaveLength(1);

    spawned[0]?.finish(0);

    const promoted = listJobs(project).find((entry) => entry.id === second.id);
    expect(promoted?.status).toBe("running");
    expect(spawnCalls).toHaveLength(2);
  });
});

describe("reconcileJobs", () => {
  it("fails a running job that has no process", () => {
    const project = nextProject();
    const job = startJob({ project, task: "do the thing", mode: "build" });
    expect(job.status).toBe("running");

    // Simulate the server restarting: the record survives, but the process reference is gone.
    const store = globalThis as unknown as {
      __slateJobs?: Map<string, { child: unknown }>;
    };
    const stored = store.__slateJobs?.get(job.id);
    expect(stored).toBeDefined();
    if (stored !== undefined) stored.child = null;

    reconcileJobs();

    const reconciled = listJobs(project).find((entry) => entry.id === job.id);
    expect(reconciled?.status).toBe("failed");
    expect(reconciled?.error).toContain("interrupted");
  });

  it("leaves a running job with a process alone", () => {
    const project = nextProject();
    const job = startJob({ project, task: "do the thing", mode: "build" });

    reconcileJobs();

    expect(listJobs(project).find((entry) => entry.id === job.id)?.status).toBe("running");
  });
});

describe("cancelJob", () => {
  it("kills the process and marks the run cancelled", () => {
    const project = nextProject();
    const job = startJob({ project, task: "long task", mode: "build" });
    const child = spawned[0];
    expect(child).toBeDefined();

    cancelJob(job.id);
    expect(child?.killed).toBe(true);

    child?.finish(null);
    expect(getJob(job.id)?.status).toBe("cancelled");
  });

  it("cancels a queued job without killing anything", () => {
    const project = nextProject();
    startJob({ project, task: "first", mode: "build" });
    const second = startJob({ project, task: "second", mode: "build" });
    expect(second.status).toBe("queued");

    cancelJob(second.id);
    expect(getJob(second.id)?.status).toBe("cancelled");
  });

  it("cancels a running job that has no process", () => {
    const project = nextProject();
    const job = startJob({ project, task: "long task", mode: "build" });

    const store = globalThis as unknown as {
      __slateJobs?: Map<string, { child: unknown }>;
    };
    const stored = store.__slateJobs?.get(job.id);
    if (stored !== undefined) stored.child = null;

    cancelJob(job.id);
    expect(getJob(job.id)?.status).toBe("cancelled");
  });
});

describe("deleteJob", () => {
  it("removes a finished run", () => {
    const project = nextProject();
    const job = startJob({ project, task: "quick task", mode: "build" });
    spawned[0]?.finish(0);

    expect(getJob(job.id)?.status).toBe("succeeded");
    deleteJob(job.id);
    expect(getJob(job.id)).toBeNull();
  });

  it("refuses to delete a running run", () => {
    const project = nextProject();
    const job = startJob({ project, task: "long task", mode: "build" });

    expect(() => deleteJob(job.id)).toThrow();
    expect(getJob(job.id)).not.toBeNull();
  });
});
