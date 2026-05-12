// trademark-lint:skip-file — single source of truth for TP-trademark policy in the typed surface; see docs/knowledge/research/trademark-tp-terms.md
//
// Single source of truth for the project's typed-surface trademark policy.
//
//  - TP_API_FIELDS — TP-trademarked field names intervals.icu emits on its
//    REST surface. The rename layer at sync/rename-tp-fields.ts reads these
//    and re-emits them as plain-English equivalents (fitness/fatigue/etc.).
//
//  - TP_DENYLIST_FIELDS — superset including names the typed surface bans
//    outright (tsb/tss/if — derived metrics, not API-emitted, but still
//    TP-trademarked). The defensive walker `assertNoTpKeysRemain` uses
//    this broader set to catch any TP key surviving rename.
//
// The trademark-lint at tools/check-trademarks.ts operates on the
// case-sensitive uppercase-token surface (CTL/ATL/TSB/TSS/IF/NP/"Normalized
// Power") in string literals and comments. It is independent of this file
// and remains the load-bearing PR-time gate; this module pins the
// typed-surface field-name policy.

export const TP_API_FIELDS = [
  "ctl",
  "atl",
  "ctlLoad",
  "atlLoad",
  "rampRate",
  "icu_ctl",
  "icu_atl",
] as const;

export const TP_DENYLIST_FIELDS = [
  ...TP_API_FIELDS,
  "tsb",
  "tss",
  "if",
] as const;
