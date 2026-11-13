/**
 * Finding the port a dev server is listening on.
 *
 * Every framework announces itself differently: Vite prints "Local:   http://localhost:5173/",
 * Next prints "- Local:            http://localhost:3000", Create React App prints "Local:
 * http://localhost:3000". Rather than special-casing each one, this looks for any URL that
 * names a port, and prefers the loopback ones.
 */

/** A URL found in some output. */
export interface DetectedPort {
  port: number;
  host: string;
  /** The line the port was found on, so the UI can show where it came from. */
  line: string;
}

/** Ports that are never a dev server, and would only confuse the preview. */
const IGNORED_PORTS = new Set([80, 443, 22, 21, 25, 53, 110, 143, 993, 995, 3306, 5432, 6379]);

/** A URL found in some output, with an optional bracketed IPv6 host. */
const URL_PATTERN = /\bhttps?:\/\/(?:\[[0-9a-fA-F:.]+\]|([a-zA-Z0-9._-]+)):(\d{1,5})\b/g;
/** A line that announces a listener: "Server listening on port 8080", "Serving HTTP on :: port 8099". */
const LISTEN_PATTERN = /\b(?:listen|listening|serving|started|now listening|now serving)\b[^\n]{0,60}?\bport\s+(\d{2,5})\b/i;

/**
 * Strip the escape sequences a terminal writes around styled text.
 *
 * A dev server colours its port: `http://127.0.0.1:<esc>[32m4321<esc>[K`, so the port number
 * is not next to the colon until the escapes are gone.
 */
export function stripAnsi(text: string): string {
  // CSI sequences, OSC strings, and the short two-byte escapes.
  return text
    .replace(/\][^]*(?:|\\)/g, "")
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[@-Z\\-_]/g, "");
}

/** A port number that could plausibly be a dev server. */
function isUsablePort(port: number): boolean {
  if (!Number.isFinite(port) || port < 1024 || port > 65535) return false;
  return !IGNORED_PORTS.has(port);
}

/** A port found in some output, with the line it appeared on. */
interface FoundPort extends DetectedPort {
  /** The line's index in the stripped output, so the newest announcement can win. */
  at: number;
}

/** Every port mentioned in one block of output, in the order it was found. */
function collectPorts(output: string): FoundPort[] {
  const found = new Map<number, FoundPort>();
  const plain = stripAnsi(output);
  const lines = plain.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line === "") continue;

    const record = (host: string, port: number): void => {
      if (!isUsablePort(port)) return;
      const existing = found.get(port);
      // A server can print the same port more than once; the latest line is where it came from.
      if (existing === undefined || index >= existing.at) {
        found.set(port, { port, host, line, at: index });
      }
    };

    URL_PATTERN.lastIndex = 0;
    let match = URL_PATTERN.exec(line);
    while (match !== null) {
      record((match[1] ?? "") as string, Number.parseInt(match[2] as string, 10));
      match = URL_PATTERN.exec(line);
    }

    const listen = LISTEN_PATTERN.exec(line);
    if (listen !== null) {
      record("127.0.0.1", Number.parseInt(listen[1] as string, 10));
    }
  }

  return [...found.values()];
}

function byLoopbackThenPort(left: DetectedPort, right: DetectedPort): number {
  // A loopback host is the one you can actually open in a frame.
  const leftLocal = isLoopback(left.host);
  const rightLocal = isLoopback(right.host);
  if (leftLocal !== rightLocal) return leftLocal ? -1 : 1;
  return left.port - right.port;
}

/** Every port mentioned in one block of output, best first. */
export function detectPorts(output: string): DetectedPort[] {
  return collectPorts(output)
    .sort(byLoopbackThenPort)
    .map(({ at: _at, ...port }) => port);
}

/**
 * Every port mentioned in one block of output, newest announcement first.
 *
 * A server that restarts on another port prints the new one after the old one, so the latest
 * announcement is the one the preview should frame. Loopback wins when two land on the same line.
 */
export function detectLatestPorts(output: string): DetectedPort[] {
  return collectPorts(output)
    .sort((left, right) => {
      if (left.at !== right.at) return right.at - left.at;
      return byLoopbackThenPort(left, right);
    })
    .map(({ at: _at, ...port }) => port);
}

/** The single port most likely to be the dev server, or null. */
export function detectPort(output: string): DetectedPort | null {
  return detectPorts(output)[0] ?? null;
}

/** The most recently announced port, or null. */
export function detectLatestPort(output: string): DetectedPort | null {
  return detectLatestPorts(output)[0] ?? null;
}

function isLoopback(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "0.0.0.0" || lower === "[::1]";
}

/** The URL a preview frame should point at. */
export function previewUrl(port: number, host = "127.0.0.1"): string {
  return `http://${host}:${port}/`;
}
