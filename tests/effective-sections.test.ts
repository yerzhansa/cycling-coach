import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CORE_SHARED_SECTIONS,
  getEffectiveSections,
  _resetWarnCacheForTesting,
  type MemorySectionSpec,
  type Sport,
} from "@cycling-coach/core";

function makeSport(id: string, sections: readonly MemorySectionSpec[]): Sport {
  return {
    id,
    soul: "",
    skills: {},
    memorySections: sections,
    mustPreserveTokens: () => [],
    intervalsActivityTypes: [],
    athleteProfileSchema: {} as never,
    tools: () => [],
  };
}

describe("getEffectiveSections", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetWarnCacheForTesting();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns Core sections + sport sections in stable order with no overlap", () => {
    const sport = makeSport("cycling", [
      { name: "cycling-profile", description: "FTP, max HR" },
      { name: "cycling-equipment", description: "Bikes, trainer" },
    ]);
    const effective = getEffectiveSections(sport);

    expect(effective.map((s) => s.name)).toEqual([
      ...CORE_SHARED_SECTIONS.map((s) => s.name),
      "cycling-profile",
      "cycling-equipment",
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once when sport declares a Core-shared name (e.g. "schedule")', () => {
    const sport = makeSport("cycling", [
      { name: "schedule", description: "sport-side schedule (overlap)" },
      { name: "cycling-profile", description: "FTP" },
    ]);
    const effective = getEffectiveSections(sport);

    // Core's "schedule" wins
    const schedule = effective.find((s) => s.name === "schedule");
    expect(schedule?.description).toBe(
      CORE_SHARED_SECTIONS.find((s) => s.name === "schedule")!.description,
    );
    // No duplicate "schedule" entries
    expect(effective.filter((s) => s.name === "schedule")).toHaveLength(1);
    // Effective list still ends with the unique sport section
    expect(effective[effective.length - 1].name).toBe("cycling-profile");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('Sport "cycling"');
    expect(warnSpy.mock.calls[0][0]).toContain('section "schedule"');
  });

  it("warns once per overlapping name when sport declares multiple", () => {
    const sport = makeSport("cycling", [
      { name: "schedule", description: "x" },
      { name: "goals", description: "y" },
      { name: "preferences", description: "z" },
    ]);
    getEffectiveSections(sport);

    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it("memoizes warns — calling N times with same overlap fires warn only once", () => {
    const sport = makeSport("cycling", [{ name: "schedule", description: "x" }]);

    getEffectiveSections(sport);
    getEffectiveSections(sport);
    getEffectiveSections(sport);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("memoizes per (sport.id, name) — different sports warn independently for the same name", () => {
    const cycling = makeSport("cycling", [{ name: "schedule", description: "c" }]);
    const running = makeSport("running", [{ name: "schedule", description: "r" }]);

    getEffectiveSections(cycling);
    getEffectiveSections(running);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0][0]).toContain('"cycling"');
    expect(warnSpy.mock.calls[1][0]).toContain('"running"');
  });

  it("returns CORE_SHARED_SECTIONS exactly when sport.memorySections is empty", () => {
    const sport = makeSport("cycling", []);
    expect(getEffectiveSections(sport)).toEqual(CORE_SHARED_SECTIONS);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
