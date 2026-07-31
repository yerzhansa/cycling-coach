import type { UsageLedgerLine } from "../../packages/core/src/usage-ledger.js";
import { TIER_J_FACT_THRESHOLD, TIER_J_MAX_FABRICATIONS } from "./rubric.js";

export interface JudgeVerdict {
  factsPreserved: string[];
  factsMissing: string[];
  fabrications: string[];
}

/** Median helper: odd-length arrays only (JUDGE_RUNS_PER_TRANSCRIPT is 3). */
export function median(values: number[]): number {
  if (values.length === 0 || values.length % 2 === 0) {
    throw new Error(`median expects a non-empty odd-length array, got length ${values.length}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) / 2];
}

/** Score one judge run against the transcript's fact inventory (ids not in the inventory are ignored). */
export function factScore(run: JudgeVerdict, inventoryIds: readonly string[]): number {
  if (inventoryIds.length === 0) return 0;
  const inventory = new Set(inventoryIds);
  const preserved = run.factsPreserved.filter((id) => inventory.has(id));
  return preserved.length / inventoryIds.length;
}

/** Tier-J verdict for one transcript from its 3 judge runs. */
export function tierJTranscriptVerdict(
  runs: JudgeVerdict[],
  inventoryIds: readonly string[],
): { medianFactScore: number; medianFabrications: number; pass: boolean } {
  const medianFactScore = median(runs.map((r) => factScore(r, inventoryIds)));
  const medianFabrications = median(runs.map((r) => r.fabrications.length));
  const pass =
    medianFactScore >= TIER_J_FACT_THRESHOLD && medianFabrications <= TIER_J_MAX_FABRICATIONS;
  return { medianFactScore, medianFabrications, pass };
}

/**
 * Majority verdict over independent summary draws of one transcript: the
 * transcript passes Tier-J iff a strict majority of its draws pass. The
 * summarizer samples, so one embellished draw among mostly-clean draws is
 * typical-behavior noise; consistent embellishment still fails.
 */
export function drawsVerdict(drawPasses: readonly boolean[]): boolean {
  const passing = drawPasses.filter(Boolean).length;
  return passing * 2 > drawPasses.length;
}

/**
 * MUST-PRESERVE diff — the binding operational definition:
 * a resolved token is IN SCOPE iff it appears (case-insensitive substring)
 * in the source text handed to compaction (the role-prefixed transcript
 * plus the carried previous summary, when present); the diff lists every
 * in-scope token that does NOT appear (case-insensitive substring) in the
 * summary. The gate requires an EMPTY diff.
 */
export function mustPreserveDiff(params: {
  tokens: readonly string[];
  sourceText: string;
  summary: string;
}): string[] {
  const source = params.sourceText.toLowerCase();
  const summary = params.summary.toLowerCase();
  return params.tokens.filter((token) => {
    const needle = token.toLowerCase();
    const inScope = source.includes(needle);
    return inScope && !summary.includes(needle);
  });
}

/**
 * Cache evidence over the exerciser's ledger lines (kind:"generate",
 * caller:"compact" only, in file order):
 *   - at least 2 lines (the pass must have made >= 2 compact calls),
 *   - line[0].cacheWriteTokens > 0  (the prefix cleared the 4096-token
 *     minimum and was written to cache),
 *   - some line[i>=1].cacheReadTokens > 0 (a later call actually read it).
 * Field names are the ledger's camelCase keys — there is no
 * cache_read_input_tokens key in usage-ledger.jsonl.
 */
export function cacheEvidence(lines: UsageLedgerLine[]): { ok: boolean; reason: string } {
  if (lines.length < 2) {
    return { ok: false, reason: `expected >= 2 compact calls, saw ${lines.length}` };
  }
  if (!((lines[0].cacheWriteTokens ?? 0) > 0)) {
    return {
      ok: false,
      reason: `first compact call did not write cache (cacheWriteTokens=${lines[0].cacheWriteTokens ?? 0})`,
    };
  }
  const readLater = lines.slice(1).some((l) => (l.cacheReadTokens ?? 0) > 0);
  if (!readLater) {
    return { ok: false, reason: "no later compact call read from cache (cacheReadTokens all 0)" };
  }
  return { ok: true, reason: "cache written on first call and read on a later call" };
}

/** Strict-JSON extraction for judge replies: parse the first {...} block; throw on failure. */
export function parseJudgeVerdict(text: string): JudgeVerdict {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("no JSON object found in judge reply");
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<JudgeVerdict>;
  if (
    !Array.isArray(parsed.factsPreserved) ||
    !Array.isArray(parsed.factsMissing) ||
    !Array.isArray(parsed.fabrications)
  ) {
    throw new Error("judge reply JSON missing required array fields");
  }
  return {
    factsPreserved: parsed.factsPreserved,
    factsMissing: parsed.factsMissing,
    fabrications: parsed.fabrications,
  };
}
