/**
 * Reference-owned MUST-PRESERVE compaction tokens — metric and framework
 * names whose verbatim form must survive 200-turn sessions. Each sport's
 * `mustPreserveTokens` spreads this array into its own list, so the Sport
 * interface stays untouched and Reference owns the canonical token set.
 */
export const REFERENCE_PRESERVE_TOKENS: readonly string[] = [];
