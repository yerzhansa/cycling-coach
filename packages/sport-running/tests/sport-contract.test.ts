import { describe, it, expect } from "vitest";
import type { MemorySnapshot } from "@enduragent/core";
import { runningSport } from "../src/sport.js";
import { runningReferenceAdapter } from "../src/reference/index.js";
import { createRunningTools } from "../src/tools.js";

describe("runningSport contract", () => {
  it("declares id 'running'", () => {
    expect(runningSport.id).toBe("running");
  });

  it("prefixes every skill key with running-", () => {
    const keys = Object.keys(runningSport.skills);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith("running-"))).toBe(true);
    expect(keys).toContain("running-zone-reference");
  });

  it("prefixes every memory section name with running-", () => {
    expect(runningSport.memorySections.every((s) => s.name.startsWith("running-"))).toBe(true);
  });

  it("ships a pace-based reference adapter whose activity types are a subset of the sport's", () => {
    expect(runningReferenceAdapter.zoneBasis).toBe("pace");
    expect(runningReferenceAdapter.decouplingBasis).toBe("pace");
    expect(runningReferenceAdapter.dfaValidated).toBe(false);
    const declared = new Set(runningSport.intervalsActivityTypes);
    expect(runningReferenceAdapter.activityTypes.every((t) => declared.has(t))).toBe(true);
  });

  it("preserves the athlete's CS across compaction", () => {
    const fakeMemory = {
      read: (section: string) =>
        section === "running-profile" ? "CS 4.0 m/s, shoes: Nova 12" : "",
      provenanceOf: () => ({ garmin: false, nonGarmin: false, unknown: true }),
    } as unknown as MemorySnapshot;
    const preserve = runningSport.mustPreserveTokens;
    expect(typeof preserve).toBe("function");
    const resolved = (preserve as Exclude<typeof preserve, readonly string[]>)(fakeMemory);
    const tokens = "tokens" in resolved ? resolved.tokens : resolved;
    expect(tokens).toContain("CS 4.0 m/s");
    expect(tokens).toContain("critical speed");
  });

  it("surfaces a calculate_zones tool", () => {
    const tools = createRunningTools(null, "UTC");
    expect(Object.keys(tools)).toContain("calculate_zones");
  });
});
