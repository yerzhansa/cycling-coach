import { describe, it, expect } from "vitest";
import { mergeSportSkills } from "@enduragent/engine/sport";
import type { MemoryStorePort, SportPersona } from "@enduragent/engine/sport";
import { buildSystemPrompt } from "../../engine/src/agent/system-prompt.js";
import { cyclingSport } from "../src/sport.js";

const fakeMemory = { getContext: () => "" } as unknown as MemoryStorePort;

describe("cycling skill keyspace", () => {
  it("prefixes every cycling skill key with cycling-", () => {
    const keys = Object.keys(cyclingSport.skills);
    expect(keys.length).toBe(8);
    expect(keys.every((k) => k.startsWith("cycling-"))).toBe(true);
    expect(keys.slice().sort()).toEqual(
      [
        "cycling-intervals-icu",
        "cycling-periodization",
        "cycling-prescription-posture",
        "cycling-race-prep",
        "cycling-recovery",
        "cycling-review",
        "cycling-workout-design",
        "cycling-zone-reference",
      ].sort(),
    );
  });

  it("renders the prefixed cycling persona byte-stably across consecutive builds", () => {
    const persona: SportPersona = {
      soul: cyclingSport.soul,
      skills: cyclingSport.skills,
      sessionClusterGapMinutes: cyclingSport.sessionClusterGapMinutes,
    };
    expect(buildSystemPrompt(persona, fakeMemory)).toBe(
      buildSystemPrompt(persona, fakeMemory),
    );
  });

  it("merges disjoint skill records", () => {
    expect(
      mergeSportSkills({ "cycling-recovery": "C" }, { "running-recovery": "R" }),
    ).toEqual({ "cycling-recovery": "C", "running-recovery": "R" });
  });

  it("throws on a colliding skill key", () => {
    expect(() => mergeSportSkills({ recovery: "C" }, { recovery: "R" })).toThrow(
      /Duplicate skill key "recovery"/,
    );
  });

  it("composes the real cycling skills with a prefixed peer without throwing", () => {
    let merged: Record<string, string> = {};
    expect(() => {
      merged = mergeSportSkills(cyclingSport.skills, { "running-periodization": "RP" });
    }).not.toThrow();
    expect(Object.keys(merged).length).toBe(9);
  });
});
