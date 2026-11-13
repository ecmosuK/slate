import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { chunkReferences, cleanIfIncomplete, missingChunks } from "../scripts/check-build.ts";

let root: string;

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A build directory with one page that asks for a chunk. */
function build(chunkId: string, writeChunk: boolean): string {
  root = mkdtempSync(join(tmpdir(), "slate-build-"));
  const server = join(root, "server");
  mkdirSync(join(server, "app"), { recursive: true });
  mkdirSync(join(server, "vendor-chunks"), { recursive: true });
  writeFileSync(
    join(server, "app", "page.js"),
    `__webpack_require__.X(0, ["${chunkId}"], () => {});`,
    "utf8",
  );
  if (writeChunk) {
    writeFileSync(join(server, "vendor-chunks", "zod.js"), "module.exports = {};", "utf8");
  }
  return server;
}

describe("the build doctor", () => {
  it("finds a chunk a compiled page asks for but that is not on disk", () => {
    const server = build("vendor-chunks/zod", false);
    expect(missingChunks(server)).toEqual(["vendor-chunks/zod.js"]);
  });

  it("finds nothing when every chunk is there", () => {
    const server = build("vendor-chunks/zod", true);
    expect(missingChunks(server)).toEqual([]);
  });

  it("reads the chunk id out of a compiled file", () => {
    expect(chunkReferences(`X(0, ["vendor-chunks/zod", "vendor-chunks/next"], () => {})`)).toEqual([
      "vendor-chunks/zod",
      "vendor-chunks/next",
    ]);
  });

  it("removes an incomplete build so the next start rebuilds it", () => {
    const server = build("vendor-chunks/zod", false);
    const nextDir = join(root, "next");
    mkdirSync(join(nextDir, "server", "vendor-chunks"), { recursive: true });
    writeFileSync(join(nextDir, "server", "app.js"), `X(0, ["vendor-chunks/zod"], () => {});`, "utf8");

    const missing = cleanIfIncomplete(nextDir);
    expect(missing).toEqual(["vendor-chunks/zod.js"]);
    expect(existsSync(nextDir)).toBe(false);
  });

  it("leaves a consistent build alone", () => {
    const server = build("vendor-chunks/zod", true);
    const nextDir = join(root, "next");
    mkdirSync(join(nextDir, "server", "vendor-chunks"), { recursive: true });
    writeFileSync(join(nextDir, "server", "vendor-chunks", "zod.js"), "x", "utf8");
    writeFileSync(join(nextDir, "server", "app.js"), `X(0, ["vendor-chunks/zod"], () => {});`, "utf8");

    expect(cleanIfIncomplete(nextDir)).toEqual([]);
    expect(existsSync(nextDir)).toBe(true);
    void server;
  });
});
