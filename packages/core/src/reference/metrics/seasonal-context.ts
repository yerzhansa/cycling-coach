/**
 * Reference layer — seasonal context.
 *
 * Maps the calendar month to a Northern-Hemisphere cycling-calendar phase
 * label. See `NOTICE.md` for license attribution.
 */

import type { MetricInput } from "./metric-input.js";

export type SeasonalContext =
  | "Off-season / Transition"
  | "Early Base"
  | "Late Base / Build"
  | "Build / Early Race Season"
  | "Peak Race Season"
  | "Late Season / Transition"
  | "Unknown";

// The upstream reads `datetime.now().month` in production; for deterministic
// snapshot capture the oracle runs against a frozen clock and the harness
// surfaces that clock here as `input.frozenNow`. Deriving the month from the
// frozenNow ISO string is what keeps the port bit-identical to the captured
// oracle outputs.
export function computeSeasonalContext(input: MetricInput): SeasonalContext {
  const month = Number(input.frozenNow.slice(5, 7));

  if (month === 11 || month === 12) {
    return "Off-season / Transition";
  } else if (month === 1 || month === 2) {
    return "Early Base";
  } else if (month === 3 || month === 4) {
    return "Late Base / Build";
  } else if (month === 5 || month === 6) {
    return "Build / Early Race Season";
  } else if (month === 7 || month === 8) {
    return "Peak Race Season";
  } else if (month === 9 || month === 10) {
    return "Late Season / Transition";
  } else {
    return "Unknown";
  }
}
