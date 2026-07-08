export interface ManifestEntry {
  id: string;
  tier: "replay" | "live";
  module: string; // module basename (no extension) under tools/s8a/scenarios/
}

export const DRIFT_FIXTURE_ID = "drift-must-fail";

/** Default replay set: every replay-tier scenario. The drift fixture is not a
 *  manifest entry at all (only --self-test touches it), but filter defensively
 *  anyway. */
export function defaultReplaySet(manifest: ManifestEntry[]): ManifestEntry[] {
  return manifest.filter((e) => e.tier === "replay" && e.id !== DRIFT_FIXTURE_ID);
}

export function selectScenarios(
  manifest: ManifestEntry[],
  flags: { scenario?: string; tier?: "live" },
): ManifestEntry[] {
  if (flags.tier === "live") {
    return manifest.filter((e) => e.tier === "live" && e.id === flags.scenario);
  }
  if (flags.scenario !== undefined) {
    return defaultReplaySet(manifest).filter((e) => e.id === flags.scenario);
  }
  return defaultReplaySet(manifest);
}
