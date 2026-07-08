import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson } from "./canonical.js";
import type { S8aRecording, ScenarioVerdict } from "./types.js";

/** Rebaseline never re-records and never rules past a real failure: only a run
 *  that is green modulo registry-matched WARNs may re-mint baselines. */
export function canRebaseline(verdicts: ScenarioVerdict[]): { ok: boolean; reason?: string } {
  for (const v of verdicts) {
    if (v.failures.length > 0) {
      return {
        ok: false,
        reason: `scenario ${v.scenario} has ${v.failures.length} undocumented failure(s): ${v.failures[0].detail}`,
      };
    }
  }
  return { ok: true };
}

/** Re-mints `baseline/` from the replay run's snapshotted artifacts and rewrites
 *  the recording's `lineage` header from the live session-line hashes.
 *  `calls[].request` and `calls[].result` are NEVER rewritten: the recording is
 *  the historical truth of what was sent to the model when the canned reply was
 *  minted — rewriting it would silently blind A1/A3 and orphan the supersession
 *  entry. (Consequence: after a supersession-WARN rebaseline, replays keep
 *  reporting the WARN until the scenario is re-RECORDED.) */
export function rebaselineFixture(params: {
  fixtureDir: string;
  snapshotHomeDir: string;
  liveTemplateHash: string | null;
}): void {
  const recordingPath = join(params.fixtureDir, "recording.json");
  const recording = JSON.parse(readFileSync(recordingPath, "utf-8")) as S8aRecording;
  if (params.liveTemplateHash !== null) {
    recording.lineage = { ...recording.lineage, templateHash: params.liveTemplateHash };
  }
  writeFileSync(recordingPath, canonicalJson(recording) + "\n", "utf-8");

  const baselineDir = join(params.fixtureDir, "baseline");
  if (existsSync(baselineDir)) rmSync(baselineDir, { recursive: true });
  cpSync(params.snapshotHomeDir, baselineDir, { recursive: true });
}
