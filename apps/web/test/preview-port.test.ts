import { describe, expect, it } from "vitest";

import { terminalPreview } from "@/lib/preview-port";

describe("terminalPreview", () => {
  it("stays hidden until the terminal announces a port", () => {
    expect(terminalPreview("")).toBeNull();
    expect(terminalPreview("> npm run dev\nStarting the app…\n")).toBeNull();
  });

  it("uses the port the terminal server announces", () => {
    const preview = terminalPreview("Serving HTTP on 0.0.0.0 port 8099 ...");
    expect(preview?.port).toBe(8099);
    expect(preview?.url).toBe("http://127.0.0.1:8099/");
  });

  it("follows a Vite dev server's local port", () => {
    const output = [
      "VITE v5.4.0  ready in 312 ms",
      "  ➜  Local:   http://localhost:5173/",
      "  ➜  Network: http://192.168.1.5:5173/",
    ].join("\n");

    expect(terminalPreview(output)?.port).toBe(5173);
  });

  it("uses the announced port, not a project default", () => {
    const output = ["Next.js ready", "  - Local: http://localhost:4100"].join("\n");
    expect(terminalPreview(output)?.port).toBe(4100);
  });

  it("follows a server that restarts on a new port", () => {
    const output = [
      "Local: http://localhost:5173",
      "Server stopped.",
      "Local: http://localhost:5174",
    ].join("\n");

    expect(terminalPreview(output)?.port).toBe(5174);
  });

  it("keeps the same preview while the terminal keeps running", () => {
    const output = "Server listening on port 4321";
    const first = terminalPreview(output);
    const reopened = terminalPreview(output);

    expect(reopened?.port).toBe(first?.port);
    expect(reopened?.url).toBe(first?.url);
  });
});
