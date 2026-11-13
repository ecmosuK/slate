import { describe, expect, it } from "vitest";

import {
  detectLatestPort,
  detectLatestPorts,
  detectPort,
  detectPorts,
  previewUrl,
} from "@slate/shared";

describe("detectPorts", () => {
  it("finds a Vite dev server", () => {
    const output = [
      "  VITE v5.4.0  ready in 312 ms",
      "",
      "  ➜  Local:   http://localhost:5173/",
      "  ➜  Network: use --host to expose",
    ].join("\n");

    expect(detectPort(output)?.port).toBe(5173);
  });

  it("finds a Next dev server", () => {
    const output = [
      "   ▲ Next.js 15.5.29",
      "   - Local:        http://localhost:3000",
      "   - Network:      http://192.168.1.5:3000",
    ].join("\n");

    expect(detectPort(output)?.port).toBe(3000);
  });

  it("finds a Create React App dev server", () => {
    const output = [
      "Compiled successfully!",
      "You can now view app in the browser.",
      "  Local:            http://localhost:3000",
    ].join("\n");

    expect(detectPort(output)?.port).toBe(3000);
  });

  it("finds a port announced without a URL", () => {
    expect(detectPort("Server listening on port 8080")?.port).toBe(8080);
  });

  it("prefers a loopback host over a network one", () => {
    const output = [
      "  - Network:      http://192.168.1.5:4000",
      "  - Local:        http://localhost:3000",
    ].join("\n");

    expect(detectPort(output)?.port).toBe(3000);
  });

  it("lists every port it finds", () => {
    const output = "Local: http://localhost:3000\nalso http://127.0.0.1:5173\n";
    expect(detectPorts(output).map((found) => found.port)).toEqual([3000, 5173]);
  });

  it("finds a port that a terminal coloured", () => {
    // A dev server colours its port, so the digits are not next to the colon.
    const output =
      "  http://192.168.1.5:\u001b[32m4321\u001b[K\r\n" +
      "  http://127.0.0.1:\u001b[32m4321\u001b[K\r\n" +
      "Hit CTRL-C to stop the server\r\n";

    expect(detectPort(output)?.port).toBe(4321);
  });

  it("finds a static server on IPv6 without a readable URL", () => {
    expect(detectPort("Serving HTTP on :: port 8098")?.port).toBe(8098);
  });

  it("finds a static server on a numeric host", () => {
    expect(detectPort("Serving HTTP on 0.0.0.0 port 8099")?.port).toBe(8099);
  });

  it("finds a port on a bare IPv6 URL", () => {
    expect(detectPort("Local: http://[::1]:5173/")?.port).toBe(5173);
  });

  it("ignores ports that are never a dev server", () => {
    expect(detectPort("Database on port 5432")).toBeNull();
  });

  it("ignores a URL with no port", () => {
    expect(detectPort("Local: http://localhost/")).toBeNull();
  });

  it("finds nothing in ordinary output", () => {
    expect(detectPort("Everything is up to date.")).toBeNull();
  });
});

describe("previewUrl", () => {
  it("points at the loopback address", () => {
    expect(previewUrl(5173)).toBe("http://127.0.0.1:5173/");
  });
});

describe("detectLatestPort", () => {
  it("puts the newest announcement first", () => {
    const output = [
      "Local: http://localhost:3000",
      "Server stopped.",
      "Local: http://localhost:5173",
    ].join("\n");

    expect(detectLatestPort(output)?.port).toBe(5173);
    expect(detectLatestPorts(output).map((found) => found.port)).toEqual([5173, 3000]);
  });

  it("still prefers the loopback host on one line", () => {
    const output = "Network: http://192.168.1.5:4000  Local: http://localhost:3000";
    expect(detectLatestPort(output)?.port).toBe(3000);
  });

  it("finds nothing in ordinary output", () => {
    expect(detectLatestPort("Everything is up to date.")).toBeNull();
  });
});
