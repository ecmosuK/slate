/**
 * Identifiers.
 *
 * The schema in `packages/db` documents UUIDv7: time-ordered, so rows sort by creation without an
 * extra column, and random enough that an id leaks nothing. Node's `crypto.randomUUID` only emits
 * version 4, so generation lives here and is shared by every writer.
 */

import { randomBytes } from "node:crypto";

const HEX = "0123456789abcdef";

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * A version 7 UUID: 48 bits of milliseconds, then a version and variant nibble, then random bits.
 * `random` must be at least ten bytes; a shorter buffer is padded with zeroes.
 */
export function uuidv7(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  const bytes = new Uint8Array(16);
  let time = Math.max(0, Math.floor(now));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  for (let index = 0; index < 10; index += 1) {
    bytes[6 + index] = random[index] ?? 0;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const digits = hex(bytes);
  return [
    digits.slice(0, 8),
    digits.slice(8, 12),
    digits.slice(12, 16),
    digits.slice(16, 20),
    digits.slice(20, 32),
  ].join("-");
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7.test(value.toLowerCase());
}

/** The millisecond timestamp carried by a UUIDv7, or null when the string is not one. */
export function uuidv7Time(value: string): number | null {
  if (!isUuidV7(value)) return null;
  return Number.parseInt(value.replaceAll("-", "").slice(0, 12), 16);
}
