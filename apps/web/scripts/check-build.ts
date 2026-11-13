/**
 * A doctor for the Next.js build directory.
 *
 * A half-written `.next` breaks the app in a way that is hard to read: the server keeps
 * `require`ing a chunk that was never written, and every route that imports it answers 500
 * with "Cannot find module './vendor-chunks/...'". That happens when files change under a
 * running dev server, or when the server is killed mid-compile.
 *
 * This script finds that state and removes it, so `npm run web` always starts from a build
 * that is consistent. It never touches source files.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Every file under a folder, as paths relative to it, using forward slashes. */
export function walk(root: string, prefix = ""): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      found.push(...walk(join(root, entry.name), relative));
    } else {
      found.push(relative);
    }
  }
  return found;
}

/**
 * The chunk ids a compiled file asks for, e.g. `vendor-chunks/zod`.
 *
 * Webpack turns a chunk id into a file name with `chunkId + ".js"`, so the file for
 * `vendor-chunks/zod` is `vendor-chunks/zod.js`.
 */
export function chunkReferences(source: string): string[] {
  const matches = source.matchAll(/["'`](vendor-chunks\/[a-zA-Z0-9@._-]+(?:\.js)?)["'`]/g);
  return [...new Set([...matches].map((match) => match[1] as string))];
}

/** The chunks a compiled file points at that are not on disk. */
export function missingChunks(serverDir: string): string[] {
  if (!existsSync(serverDir)) return [];

  const onDisk = new Set(walk(serverDir));
  const missing = new Set<string>();

  for (const relative of walk(serverDir)) {
    if (!relative.endsWith(".js")) continue;
    const source = readFileSync(join(serverDir, relative), "utf8");
    for (const reference of chunkReferences(source)) {
      const name = reference.endsWith(".js") ? reference : `${reference}.js`;
      if (!onDisk.has(name)) missing.add(name);
    }
  }

  return [...missing];
}

/** Remove the build directory when it is incomplete. Returns what was found missing. */
export function cleanIfIncomplete(nextDir: string): string[] {
  const missing = missingChunks(join(nextDir, "server"));
  if (missing.length > 0) {
    rmSync(nextDir, { recursive: true, force: true });
  }
  return missing;
}

function main(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const nextDir = join(here, "..", ".next");

  if (!existsSync(nextDir)) {
    process.stdout.write("No build directory yet; nothing to check.\n");
    return;
  }

  const missing = missingChunks(join(nextDir, "server"));
  if (missing.length === 0) {
    process.stdout.write("Build directory is consistent.\n");
    return;
  }

  process.stdout.write(
    `Build directory is incomplete (${missing.length} missing chunk(s), e.g. ${missing[0]}).\n` +
      "Removing it so the next start rebuilds cleanly.\n",
  );
  rmSync(nextDir, { recursive: true, force: true });
}

main();
