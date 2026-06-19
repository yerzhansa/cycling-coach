import { describe, it, expect } from "vitest";
import type { MemorySnapshot, MemoryStore } from "@enduragent/core";
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
    } as unknown as MemorySnapshot;
    const preserve = runningSport.mustPreserveTokens;
    expect(typeof preserve).toBe("function");
    const tokens = (preserve as (m: MemorySnapshot) => readonly string[])(fakeMemory);
    expect(tokens).toContain("CS 4.0 m/s");
    expect(tokens).toContain("critical speed");
  });

  it("surfaces a calculate_zones tool", () => {
    const tools = createRunningTools({} as MemoryStore, null, "UTC");
    expect(Object.keys(tools)).toContain("calculate_zones");
  });
});
