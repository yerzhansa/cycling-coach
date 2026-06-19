import { describe, it, expect } from "vitest";
import type { MemoryStore, ResolvedCs } from "@enduragent/core";
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

// Auto-resolution path: CS comes from the synced anchor (the resolvedCs getter Core
// feeds per turn) when the LLM omits criticalSpeedMps.
function execZonesResolved(
  input: Record<string, unknown>,
  resolved: ResolvedCs | null,
): Promise<{
  zones?: unknown[];
  criticalSpeedMps?: number;
  csSource?: string;
  confidence?: string;
  anchorOrigin?: string;
  platformConfidence?: string;
  error?: string;
}> {
  const tools = createRunningTools({} as MemoryStore, null, "UTC", () => resolved);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (tools.calculate_zones as any).execute(input, {});
}

describe("calculate_zones CS auto-resolution", () => {
  it("uses the synced platform anchor when criticalSpeedMps is omitted", async () => {
    const out = await execZonesResolved(
      { paceUnits: "MINS_KM" },
      { criticalSpeedMps: 4.2, source: "platform", confidence: "high" },
    );
    expect(out.zones).toHaveLength(6);
    expect(out.criticalSpeedMps).toBe(4.2);
    expect(out.anchorOrigin).toBe("auto-resolved");
    expect(out.csSource).toBe("platform");
    expect(out.confidence).toBe("platform-reported");
    expect(out.platformConfidence).toBe("high");
  });

  it("reports manual provenance when the synced anchor is a manual override", async () => {
    const out = await execZonesResolved({}, { criticalSpeedMps: 3.8, source: "athlete_manual", confidence: null });
    expect(out.anchorOrigin).toBe("auto-resolved");
    expect(out.csSource).toBe("athlete_manual");
    expect(out.confidence).toBe("coach-entered");
    expect(out.platformConfidence).toBeUndefined();
  });

  it("lets an explicit criticalSpeedMps override the synced anchor", async () => {
    const out = await execZonesResolved(
      { criticalSpeedMps: 5.0, csSource: "athlete_manual" },
      { criticalSpeedMps: 4.0, source: "platform", confidence: "high" },
    );
    expect(out.criticalSpeedMps).toBe(5.0);
    expect(out.anchorOrigin).toBe("supplied");
    expect(out.csSource).toBe("athlete_manual");
  });

  it("returns a no_cs_anchor error when neither synced nor supplied", async () => {
    const out = await execZonesResolved({}, null);
    expect(out.error).toBe("no_cs_anchor");
    expect(out.zones).toBeUndefined();
  });

  it("returns no_cs_anchor when no resolver is wired and no value supplied", async () => {
    const tools = createRunningTools({} as MemoryStore, null, "UTC");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await (tools.calculate_zones as any).execute({}, {});
    expect(out.error).toBe("no_cs_anchor");
  });
});
