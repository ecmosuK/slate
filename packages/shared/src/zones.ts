/**
 * The zone grammar.
 *
 * A README can carry three blocks, each with exactly one owner:
 *
 *   <!-- slate:status:begin project=foo -->   ...   <!-- slate:status:end -->   Slate
 *   <!-- slate:plan:begin project=foo version=1 --> ... <!-- slate:plan:end -->   the agent
 *   <!-- slate:requests:begin --> ... <!-- slate:requests:end -->                   you
 *
 * Rules that this module enforces:
 *
 * - Everything outside a block is preserved byte-for-byte.
 * - Markers inside fenced code blocks are ignored, so documentation can show examples.
 * - CRLF, LF and a UTF-8 BOM are all accepted.
 * - Exactly one block per zone per file. A duplicate is reported, never merged.
 * - Unknown zones are ignored rather than rejected, so a future zone cannot break an old parser.
 */

export const ZONES = ["status", "plan", "requests"] as const;

export type Zone = (typeof ZONES)[number];

export interface ZoneBlock {
  zone: Zone;
  /** Attributes on the begin marker, in the order they were written. */
  attrs: Record<string, string>;
  /** Content between the markers, without the markers. */
  body: string;
  /** The whole block including both markers. */
  raw: string;
  /** 1-based line number of the begin marker. */
  startLine: number;
  /** 1-based line number of the end marker. */
  endLine: number;
  /** Byte offset of the begin marker line. */
  start: number;
  /** Byte offset just past the end marker line's text, excluding its line ending. */
  end: number;
}

export interface ScanResult {
  blocks: ZoneBlock[];
  /** Zones that appeared more than once. The file is malformed and must not be written. */
  duplicates: Zone[];
  /** Zones that were opened but never closed. */
  unterminated: Zone[];
  /** Zone names that are not part of the grammar. They are ignored. */
  unknownZones: string[];
}

const BEGIN_MARKER = /^\s*<!--\s*slate:([a-z][a-z0-9_-]*):begin(.*?)\s*-->\s*$/;
const END_MARKER = /^\s*<!--\s*slate:([a-z][a-z0-9_-]*):end\s*-->\s*$/;
const ATTRIBUTE = /([a-z][a-z0-9_]*)=([A-Za-z0-9._:-]+)/g;

interface Line {
  text: string;
  start: number;
  end: number;
  eol: string;
}

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  const re = /\r\n|\n|\r/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    lines.push({
      text: text.slice(cursor, match.index),
      start: cursor,
      end: match.index,
      eol: match[0],
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    lines.push({ text: text.slice(cursor), start: cursor, end: text.length, eol: "" });
  }
  return lines;
}

function isFence(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

export function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined && !(key in attrs)) {
      attrs[key] = value;
    }
  }
  return attrs;
}

export function renderAttributes(attrs: Record<string, string>): string {
  const parts = Object.entries(attrs).map(([key, value]) => ` ${key}=${value}`);
  return parts.join("");
}

function isKnownZone(zone: string): zone is Zone {
  return (ZONES as readonly string[]).includes(zone);
}

/** Find every zone block in a document. */
export function scanZones(text: string): ScanResult {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const body = hasBom ? text.slice(1) : text;
  const offset = hasBom ? 1 : 0;
  const lines = splitLines(body);

  const blocks: ZoneBlock[] = [];
  const duplicates: Zone[] = [];
  const unterminated: Zone[] = [];
  const unknownZones: string[] = [];

  let fence = false;
  let open: { zone: Zone; attrs: Record<string, string>; startLine: number; start: number } | null =
    null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;

    if (isFence(line.text)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;

    if (open === null) {
      const begin = BEGIN_MARKER.exec(line.text);
      if (begin === null) continue;
      const zone = begin[1] ?? "";
      if (!isKnownZone(zone)) {
        if (!unknownZones.includes(zone)) unknownZones.push(zone);
        continue;
      }
      open = {
        zone,
        attrs: parseAttributes(begin[2] ?? ""),
        startLine: index + 1,
        start: line.start + offset,
      };
      continue;
    }

    const end = END_MARKER.exec(line.text);
    if (end === null) continue;
    const endZone = end[1] ?? "";
    if (endZone !== open.zone) continue;

    const bodyText = lines
      .slice(open.startLine, index)
      .map((entry) => entry.text)
      .join("\n");

    blocks.push({
      zone: open.zone,
      attrs: open.attrs,
      body: bodyText,
      raw: text.slice(open.start, line.end + offset),
      startLine: open.startLine,
      endLine: index + 1,
      start: open.start,
      end: line.end + offset,
    });
    open = null;
  }

  if (open !== null) unterminated.push(open.zone);

  for (const zone of ZONES) {
    if (blocks.filter((block) => block.zone === zone).length > 1) duplicates.push(zone);
  }

  return { blocks, duplicates, unterminated, unknownZones };
}

/** Find one zone block. Returns undefined when the zone is absent. */
export function findZone(text: string, zone: Zone): ZoneBlock | undefined {
  const scan = scanZones(text);
  return scan.blocks.find((block) => block.zone === zone);
}

function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf >= lf && crlf > 0 ? "\r\n" : "\n";
}

/**
 * The document with every zone block removed.
 *
 * This is what a CI check compares: if the text outside the blocks changed, someone edited prose
 * that no automated tool owns.
 */
export function stripZones(text: string): string {
  const scan = scanZones(text);
  if (scan.blocks.length === 0) return text;

  const sorted = [...scan.blocks].sort((left, right) => left.start - right.start);
  let result = "";
  let cursor = 0;
  for (const block of sorted) {
    result += text.slice(cursor, block.start);
    cursor = block.end;
    // Swallow the line ending that followed the end marker so the join stays tidy.
    if (text[cursor] === "\r" && text[cursor + 1] === "\n") cursor += 2;
    else if (text[cursor] === "\n" || text[cursor] === "\r") cursor += 1;
  }
  result += text.slice(cursor);
  return result;
}

export interface UpsertResult {
  text: string;
  changed: boolean;
}

/**
 * Replace the body of a zone, or append the zone if it is missing.
 *
 * Everything outside the zone is preserved byte-for-byte, including the line ending style and
 * any byte-order mark.
 */
export function upsertZone(
  text: string,
  zone: Zone,
  body: string,
  attrs: Record<string, string> = {},
): UpsertResult {
  const hasBom = text.charCodeAt(0) === 0xfeff;
  const scan = scanZones(text);
  const existing = scan.blocks.find((block) => block.zone === zone);
  const eol = dominantEol(text);

  const trimmedBody = body.replace(/\r\n|\r/g, "\n").replace(/\n+$/, "");

  if (existing !== undefined) {
    const merged: Record<string, string> = { ...existing.attrs, ...attrs };
    const markerOpen = `<!-- slate:${zone}:begin${renderAttributes(merged)} -->`;
    const markerClose = `<!-- slate:${zone}:end -->`;
    const replacement = `${markerOpen}${eol}${trimmedBody}${eol}${markerClose}`;
    const next = text.slice(0, existing.start) + replacement + text.slice(existing.end);
    return { text: next, changed: next !== text };
  }

  const merged: Record<string, string> = { ...attrs };
  const markerOpen = `<!-- slate:${zone}:begin${renderAttributes(merged)} -->`;
  const markerClose = `<!-- slate:${zone}:end -->`;
  const block = `${markerOpen}${eol}${trimmedBody}${eol}${markerClose}`;

  const bom = hasBom ? "\uFEFF" : "";
  const base = bom + text.slice(hasBom ? 1 : 0);
  const separator = base.endsWith("\n") || base.length === 0 ? "" : eol;
  const needsBlankLine = base.trim().length > 0;
  const next = `${base}${separator}${needsBlankLine ? eol : ""}${block}${eol}`;
  return { text: next, changed: true };
}
