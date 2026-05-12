// trademark-lint:skip-file — anti-corruption layer per ADR-0012; this file
// legitimately names TP-trademarked source fields in its rename tables and
// JSDoc so the layer can read them.
//
// Anti-corruption layer between intervals.icu's TP-trademarked API field
// names and the project's plain-English vocabulary. Reads ctl/atl/ctlLoad/
// atlLoad/rampRate/icu_ctl/icu_atl via Record-key access and emits
// fitness/fatigue/fitnessContribution/fatigueContribution/
// weeklyFitnessChange/fitnessAtEnd/fatigueAtEnd; strips the source TP keys.
// All other fields ride through verbatim.
//
// `assertNoTpKeysRemain` is the defensive walker that runs after rename —
// it walks the entire bundle and throws if any TP-denylist key survives
// anywhere (covers the "intervals.icu adds nested TP aggregates"
// failure mode). The error path uses array-index form `[<i>]` only —
// no row-id values appear in the path so operator log forwarding is safe.
//
// Every sync path into Reference MUST call the rename layer between API
// parse and any downstream consumer — this is the single anti-corruption
// boundary for this vocabulary. See ADR-0012 + reference/CONTEXT.md.

import { TP_DENYLIST_FIELDS } from "../trademark-policy.js";

export interface NormalizedWellnessFields {
  fitness?: number | null;
  fatigue?: number | null;
  fitnessContribution?: number | null;
  fatigueContribution?: number | null;
  weeklyFitnessChange?: number | null;
}

export interface NormalizedActivityFields {
  fitnessAtEnd?: number | null;
  fatigueAtEnd?: number | null;
}

/** Aggregator passed by the operator CLI to surface non-number TP values
 *  (real-world drift: API ships a string or boolean where a number was
 *  expected) without blocking the whole pipeline on one bad row. Caller
 *  emits a stderr warning when any counter is non-zero. */
export interface RenameSummary {
  skippedNonNumeric: Record<string, number>;
}

const WELLNESS_TP_TO_PLAIN: ReadonlyArray<readonly [string, keyof NormalizedWellnessFields]> = [
  ["ctl", "fitness"],
  ["atl", "fatigue"],
  ["ctlLoad", "fitnessContribution"],
  ["atlLoad", "fatigueContribution"],
  ["rampRate", "weeklyFitnessChange"],
];
const WELLNESS_TP_SET: ReadonlySet<string> = new Set(WELLNESS_TP_TO_PLAIN.map(([src]) => src));

const ACTIVITY_TP_TO_PLAIN: ReadonlyArray<readonly [string, keyof NormalizedActivityFields]> = [
  ["icu_ctl", "fitnessAtEnd"],
  ["icu_atl", "fatigueAtEnd"],
];
const ACTIVITY_TP_SET: ReadonlySet<string> = new Set(ACTIVITY_TP_TO_PLAIN.map(([src]) => src));

function applyKeyRename(
  raw: Record<string, unknown>,
  mapping: ReadonlyArray<readonly [string, string]>,
  tpKeys: ReadonlySet<string>,
  summary: RenameSummary | undefined,
): Record<string, unknown> {
  // Collision check before any work: if the input already has both a TP
  // source field AND the rename target with a non-null value, the rename
  // would silently overwrite real data. For an anti-corruption layer that
  // is the single source of truth for this vocabulary, silent overwrite
  // on conflict is the wrong default — throw and force the contributor
  // to investigate.
  //
  // We tolerate `target === null` because intervals.icu ships the rename
  // targets as `null`-valued keys today (e.g., `fatigue: null` accompanies
  // `atl: 38.4`) — the inputs.ts comment notes the API's `fatigue` field
  // is reserved for a subjective 1-5 scale that the API doesn't currently
  // populate. When (if) it starts populating it, this throws.
  for (const [src, dst] of mapping) {
    if (src in raw && dst in raw) {
      const dstValue = raw[dst];
      if (dstValue !== null && dstValue !== undefined) {
        throw new Error(
          `renameTpFields: collision — input has both source '${src}' and target '${dst}' with a non-null value.` +
            ` The anti-corruption layer would silently overwrite real data.` +
            ` Update reference/sync/rename-tp-fields.ts.`,
        );
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (tpKeys.has(key)) continue;
    out[key] = value;
  }
  for (const [src, dst] of mapping) {
    if (!(src in raw)) continue;
    const v = raw[src];
    if (typeof v === "number" || v === null) {
      out[dst] = v;
    } else if (v !== undefined && summary) {
      summary.skippedNonNumeric[src] = (summary.skippedNonNumeric[src] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Rename TP-trademarked wellness fields to plain-English equivalents.
 * Strips the source TP keys; non-TP fields ride through verbatim.
 * Returns a new object — input is not mutated.
 */
export function renameTpFieldsOnWellnessRow(
  raw: Record<string, unknown>,
  summary?: RenameSummary,
): Record<string, unknown> & NormalizedWellnessFields {
  return applyKeyRename(raw, WELLNESS_TP_TO_PLAIN, WELLNESS_TP_SET, summary) as Record<
    string,
    unknown
  > &
    NormalizedWellnessFields;
}

/**
 * Rename TP-trademarked activity fields (icu_ctl/icu_atl) to plain-English
 * equivalents. Strips the source TP keys; non-TP fields ride through verbatim.
 * Returns a new object — input is not mutated.
 */
export function renameTpFieldsOnActivity(
  raw: Record<string, unknown>,
  summary?: RenameSummary,
): Record<string, unknown> & NormalizedActivityFields {
  return applyKeyRename(raw, ACTIVITY_TP_TO_PLAIN, ACTIVITY_TP_SET, summary) as Record<
    string,
    unknown
  > &
    NormalizedActivityFields;
}

const DENYLIST_SET: ReadonlySet<string> = new Set(TP_DENYLIST_FIELDS);

/**
 * Recursive walker that throws if any TP-denylist key survives rename.
 * The error path uses `[<index>]` array form only — never includes object
 * values like row ids — so operator log forwarding stays safe.
 *
 * Defense-in-depth catch for "intervals.icu adds a nested TP aggregate"
 * drift (e.g., `wellness[i].weeklyAggregates.ctl`). The rename layer is
 * top-level only; this walker covers everything below.
 */
export function assertNoTpKeysRemain(value: unknown, path = ""): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoTpKeysRemain(value[i], `${path}[${i}]`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (DENYLIST_SET.has(key)) {
        const childPath = path === "" ? key : `${path}.${key}`;
        throw new Error(
          `assertNoTpKeysRemain: TP-trademarked key surviving rename at ${childPath}` +
            ` — update reference/sync/rename-tp-fields.ts`,
        );
      }
      const childPath = path === "" ? key : `${path}.${key}`;
      assertNoTpKeysRemain(v, childPath);
    }
  }
}
