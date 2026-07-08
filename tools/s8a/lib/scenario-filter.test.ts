import { describe, expect, it } from "vitest";

import { defaultReplaySet, selectScenarios, type ManifestEntry } from "./scenario-filter.js";

const manifest: ManifestEntry[] = [
  { id: "turn-basic-wellness", tier: "replay", module: "turn-basic-wellness" },
  { id: "inj-01", tier: "replay", module: "inj-01" },
  { id: "synthetic-live-probe", tier: "live", module: "synthetic-live-probe" },
  { id: "drift-must-fail", tier: "replay", module: "drift-must-fail" },
];

describe("scenario filter", () => {
  it("default set = replay tier minus drift-must-fail; live scenarios excluded", () => {
    expect(defaultReplaySet(manifest).map((e) => e.id)).toEqual(["turn-basic-wellness", "inj-01"]);
  });

  it("--scenario selects exactly one replay scenario", () => {
    expect(selectScenarios(manifest, { scenario: "inj-01" }).map((e) => e.id)).toEqual(["inj-01"]);
    expect(selectScenarios(manifest, { scenario: "synthetic-live-probe" })).toEqual([]);
  });

  it("--tier=live selects only the named live scenario", () => {
    expect(
      selectScenarios(manifest, { tier: "live", scenario: "synthetic-live-probe" }).map((e) => e.id),
    ).toEqual(["synthetic-live-probe"]);
    expect(selectScenarios(manifest, { tier: "live", scenario: "turn-basic-wellness" })).toEqual([]);
  });
});
