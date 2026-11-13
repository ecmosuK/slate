import { describe, expect, it } from "vitest";

import { costMicrosFromEvent, enforceModelCap } from "@/lib/jobs";
import { canSpend, capRemainingDollars } from "@/lib/spend";
import type { SlateConfig } from "@slate/shared";

function configWith(caps: Record<string, number | null>): SlateConfig {
  return {
    openrouter: { apiKey: null, defaultModel: null, caps },
    gemini: { apiKey: null },
    projectsRoot: null,
  };
}

describe("costMicrosFromEvent", () => {
  it("converts a step_finish cost into millionths of a dollar", () => {
    expect(
      costMicrosFromEvent(JSON.stringify({ type: "step_finish", part: { cost: 0.001234 } })),
    ).toBe(1234);
  });

  it("rounds to the nearest micro-dollar", () => {
    expect(
      costMicrosFromEvent(JSON.stringify({ type: "step_finish", part: { cost: 0.0012346 } })),
    ).toBe(1235);
  });

  it("returns null for anything that is not a step_finish with a positive cost", () => {
    expect(costMicrosFromEvent(JSON.stringify({ type: "text", part: { text: "hi" } }))).toBeNull();
    expect(costMicrosFromEvent("{ not json")).toBeNull();
    expect(costMicrosFromEvent(JSON.stringify({ type: "step_finish", part: {} }))).toBeNull();
    expect(costMicrosFromEvent(JSON.stringify({ type: "step_finish", part: { cost: 0 } }))).toBeNull();
    expect(costMicrosFromEvent(JSON.stringify({ type: "step_finish", part: { cost: -1 } }))).toBeNull();
    expect(costMicrosFromEvent(JSON.stringify({ type: "step_finish", part: { cost: "x" } }))).toBeNull();
  });
});

describe("model spend caps", () => {
  it("an uncapped model can always spend", () => {
    const config = configWith({});
    expect(capRemainingDollars(config, "openrouter/free")).toBeNull();
    expect(canSpend(config, "openrouter/free", 1_000_000)).toEqual({ ok: true, remaining: null });
  });

  it("tracks the remaining dollars under a cap", () => {
    const config = configWith({ "openrouter/free": 1 });
    expect(capRemainingDollars(config, "openrouter/free")).toBe(1);
    expect(canSpend(config, "openrouter/free", 500_000)).toEqual({ ok: true, remaining: 0.5 });
    expect(canSpend(config, "openrouter/free", 1_000_000)).toEqual({ ok: true, remaining: 0 });
    expect(canSpend(config, "openrouter/free", 1_000_001)).toEqual({ ok: false, remaining: 0 });
  });

  it("a cap of zero refuses every job on that model", () => {
    const config = configWith({ "openrouter/free": 0 });
    expect(() => enforceModelCap("openrouter/free", config)).toThrow(/spend cap/);
    expect(() => enforceModelCap("other-model", config)).not.toThrow();
  });

  it("a model below its cap is allowed", () => {
    const config = configWith({ "openrouter/free": 5 });
    expect(() => enforceModelCap("openrouter/free", config)).not.toThrow();
  });

  it("a model at its cap is refused", () => {
    const config = configWith({ "openrouter/free": 0 });
    expect(() => enforceModelCap("openrouter/free", config)).toThrow(/spend cap/);
  });
});
