import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  contentTypeFor,
  hasStaticEntry,
  resolvePreviewFile,
  staticEntryFolder,
} from "@slate/bridge";

const created: string[] = [];

function makeFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "slate-preview-"));
  created.push(folder);
  return folder;
}

afterEach(() => {
  while (created.length) {
    const folder = created.pop();
    if (folder) rmSync(folder, { recursive: true, force: true });
  }
});

describe("resolvePreviewFile", () => {
  it("serves index.html for the root", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "index.html"), "<h1>hi</h1>");
    expect(resolvePreviewFile(folder, "/")).toEqual({
      file: join(folder, "index.html"),
      status: 200,
    });
  });

  it("serves nested files", () => {
    const folder = makeFolder();
    mkdirSync(join(folder, "assets"));
    writeFileSync(join(folder, "index.html"), "<h1>hi</h1>");
    writeFileSync(join(folder, "assets", "app.css"), "body{}");
    expect(resolvePreviewFile(folder, "/assets/app.css").file).toBe(
      join(folder, "assets", "app.css"),
    );
  });

  it("falls back to index.html for a deep route", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "index.html"), "<h1>hi</h1>");
    expect(resolvePreviewFile(folder, "/some/deep/route").file).toBe(
      join(folder, "index.html"),
    );
  });

  it("refuses a path that climbs out of the folder", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "index.html"), "<h1>hi</h1>");
    expect(resolvePreviewFile(folder, "/../secret.txt").status).toBe(403);
    expect(resolvePreviewFile(folder, "/../../etc/passwd").status).toBe(403);
    expect(resolvePreviewFile(folder, "/a/../../b").status).toBe(403);
  });

  it("refuses encoded climbs out of the folder", () => {
    const folder = makeFolder();
    writeFileSync(join(folder, "index.html"), "<h1>hi</h1>");
    expect(resolvePreviewFile(folder, "/%2e%2e/%2e%2e/windows/win.ini").status).toBe(403);
  });

  it("answers 404 when nothing is there and there is no fallback", () => {
    const folder = makeFolder();
    expect(resolvePreviewFile(folder, "/", { spaFallback: false }).status).toBe(404);
  });
});

describe("contentTypeFor", () => {
  it("picks a browser-friendly content type per extension", () => {
    expect(contentTypeFor("a.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("a.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("a.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("a.png")).toBe("image/png");
    expect(contentTypeFor("a.bin")).toBe("application/octet-stream");
  });
});

describe("static entry", () => {
  it("finds an index.html at the root or in a known folder", () => {
    const root = makeFolder();
    expect(hasStaticEntry(root)).toBe(false);
    expect(staticEntryFolder(root)).toBeNull();

    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public", "index.html"), "<h1>hi</h1>");
    expect(hasStaticEntry(root)).toBe(true);
    expect(staticEntryFolder(root)).toBe(join(root, "public"));
  });
});
