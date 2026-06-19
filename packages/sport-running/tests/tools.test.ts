import { describe, it, expect } from "vitest";
import type { MemoryStore } from "@enduragent/core";
import { createRunningTools } from "../src/tools.js";

// The Vercel AI SDK wraps execute; call it directly with a stub options arg
// (the running tool ignores options). Schema validation is the SDK's job at
// call time — here we exercise the execute path's clamp/confidence logic.
function execZones(input: Record<string, unknown>): Promise<{
  zones: unknown[];
  csSource: string;
  confidence: string;
  thresholdDefinition: string;
  framing: string;
  clampApplied?: { requested: number; clamped: number };
}> {
  const tools = createRunningTools({} as MemoryStore, null, "UTC");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tools.calculate_zones as any).execute(input, {});
}

describe("calculate_zones tool", () => {
  it("returns 6 zones + threshold definition + platform-reported confidence by default", async () => {
    const out = await execZones({ criticalSpeedMps: 4.0, paceUnits: "MINS_KM" });
    expect(out.zones).toHaveLength(6);
    expect(out.csSource).toBe("platform");
    expect(out.confidence).toBe("platform-reported");
    expect(typeof out.thresholdDefinition).toBe("string");
    expect(typeof out.framing).toBe("string");
    expect(out.clampApplied).toBeUndefined();
  });

  it("labels coach-entered confidence when csSource is athlete_manual", async () => {
    const out = await execZones({ criticalSpeedMps: 4.0, csSource: "athlete_manual" });
    expect(out.csSource).toBe("athlete_manual");
    expect(out.confidence).toBe("coach-entered");
  });

  it("clamps a too-high override down to the ceiling and discloses it", async () => {
    const out = await execZones({ criticalSpeedMps: 4.0, lowerFractionOverride: 0.95 });
    expect(out.clampApplied).toEqual({ requested: 0.95, clamped: 0.88 });
  });

  it("clamps a too-low override up to the floor and discloses it", async () => {
    const out = await execZones({ criticalSpeedMps: 4.0, lowerFractionOverride: 0.7 });
    expect(out.clampApplied).toEqual({ requested: 0.7, clamped: 0.78 });
  });

  it("does NOT disclose a clamp for an in-range override", async () => {
    const out = await execZones({ criticalSpeedMps: 4.0, lowerFractionOverride: 0.85 });
    expect(out.clampApplied).toBeUndefined();
  });
});
