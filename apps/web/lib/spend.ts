/**
 * Per-model spend tracking and caps.
 *
 * Spend is recorded against each model id in millionths of a dollar. Job runs record their own
 * cost (opencode reports it per step); chat turns add to the same totals. A cap set in config
 * limits how much any one model may spend; once the remaining amount reaches zero the model is
 * refused until the cap is raised or removed.
 */

import { listJobs } from "./jobs";
import { capForModel, type SlateConfig } from "@slate/shared";

const chatSpend = new Map<string, number>(); // model id -> micros

/** Everything a job or a chat turn has charged to one model, in millionths of a dollar. */
export function spentMicrosForModel(modelId: string): number {
  let total = 0;
  for (const job of listJobs()) {
    if (job.model === modelId) total += job.costMicros;
  }
  return total + (chatSpend.get(modelId) ?? 0);
}

/** Add chat-turn cost to one model's total. */
export function recordChatSpend(modelId: string, micros: number): void {
  if (micros <= 0) return;
  chatSpend.set(modelId, (chatSpend.get(modelId) ?? 0) + micros);
}

/** How many dollars are left under the model's cap, or null when it is uncapped. */
export function capRemainingDollars(config: SlateConfig, modelId: string): number | null {
  const cap = capForModel(config, modelId);
  if (cap === null) return null;
  return cap - spentMicrosForModel(modelId) / 1_000_000;
}

/**
 * Whether spending `micros` more on `modelId` stays within its cap.
 * `remaining` is the dollars left after the spend (zero when the cap is exactly reached).
 */
export function canSpend(
  config: SlateConfig,
  modelId: string,
  micros: number,
): { ok: boolean; remaining: number | null } {
  const cap = capForModel(config, modelId);
  if (cap === null) return { ok: true, remaining: null };
  const remaining = cap - (spentMicrosForModel(modelId) + micros) / 1_000_000;
  return { ok: remaining >= 0, remaining: remaining < 0 ? 0 : remaining };
}

/** Format millionths of a dollar as dollars and cents. */
export function formatDollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}
