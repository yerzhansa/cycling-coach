// trademark-lint:skip-file — this module centralizes the forbidden-vocabulary
// patterns; the file must be lint-skipped so the patterns themselves don't trip
// the scan. Scenario prose stays scanned because scenarios only import from here.

// Case-sensitive on the abbreviations: \bIF\b with the `i` flag would match the
// English word "if" everywhere.
export const TRADEMARK_FORBIDDEN: RegExp[] = [
  /\b(NP|TSS|CTL|ATL|TSB|IF)\b/,
  /Normalized\s+Power/i,
];

export const CANARY_PREFIX = "S8A-CANARY-";

export function canary(caseId: string): string {
  return `${CANARY_PREFIX}${caseId}`;
}

export function needleMatches(needle: string | RegExp, text: string): boolean {
  return typeof needle === "string" ? text.includes(needle) : needle.test(text);
}

export function needleLabel(needle: string | RegExp): string {
  return typeof needle === "string" ? JSON.stringify(needle) : String(needle);
}
