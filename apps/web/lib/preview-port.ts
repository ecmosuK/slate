/**
 * The preview a terminal points at.
 *
 * Slate never starts the preview itself. The user runs a server in the terminal pane, and once
 * that output announces a port the banner grows a Preview button that frames that exact port.
 * Closing the preview only hides the frame: the terminal process keeps running, so reopening it
 * shows the same server instead of starting a second one.
 */

import { detectLatestPort, previewUrl } from "@slate/shared/port-detect";

export interface TerminalPreview {
  /** The port the terminal announced. */
  port: number;
  /** The frame URL for that port. */
  url: string;
}

/** The preview the terminal's output points at, or null while no server has announced a port. */
export function terminalPreview(output: string): TerminalPreview | null {
  const best = detectLatestPort(output);
  if (best === null) return null;
  return { port: best.port, url: previewUrl(best.port) };
}
