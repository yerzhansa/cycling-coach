/**
 * Reference layer — load-management metrics.
 *
 * Computers in this module port the metric math from the Reference layer's
 * upstream protocol. See `NOTICE.md` for license attribution.
 */

import type { Activity } from "../schemas/inputs.js";

import type { MetricInput } from "./metric-input.js";

/**
 * Acute:Chronic Workload Ratio (Gabbett 2016).
 *
 * Acute load = mean daily Load over the trailing 7 days (today and the
 * six prior days). Chronic load = mean daily Load over the trailing 28
 * days. Days with no activity contribute 0; the denominator is the
 * calendar window length, not the count of active days.
 *
 * Returns `round(acute / chronic, 2)` when chronic > 0, else `null`. The
 * round is half-to-even (banker's rounding) to mirror Python's `round()`
 * behaviour bit-identically.
 *
 * Upstream source mirrored line-by-line: `sync.py:3023-3028`
 * (`_calculate_derived_metrics`) plus the per-day aggregation helper at
 * `sync.py:3629-3644` (the daily-load aggregator). See `NOTICE.md` for
 * upstream attribution.
 *
 * Return shape is the raw upstream output (number or null), not the
 * discriminated-union envelope from ADR-0014; per the 2026-05-21 ADR-0014
 * scope clarification, raw compute functions feed the parity gate and a
 * sibling envelope wrapper feeds the curator.
 *
 * @see Gabbett, T.J. (2016). The training-injury prevention paradox:
 *      should athletes be training smarter and harder?
 *      Br J Sports Med 50(5):273-280. DOI: 10.1136/bjsports-2015-095788
 */
export function computeAcwr(input: MetricInput): number | null {
  const fixture = input.fixture as { activities?: Activity[] };
  const activities = fixture.activities ?? [];

  const dailyLoad7d = getDailyLoad(activities, 7, input.frozenNow);
  const dailyLoad28d = getDailyLoad(activities, 28, input.frozenNow);

  const load7dTotal = dailyLoad7d.reduce((s, t) => s + t, 0);
  const load28dTotal = dailyLoad28d.reduce((s, t) => s + t, 0);

  const acuteLoad = load7dTotal ? load7dTotal / 7 : 0;
  const chronicLoad = load28dTotal ? load28dTotal / 28 : 0;

  if (chronicLoad <= 0) return null;
  return roundHalfEven(acuteLoad / chronicLoad, 2);
}

function getDailyLoad(
  activities: Activity[],
  days: number,
  frozenNow: string,
): number[] {
  const dailyLoad = new Map<string, number>();
  for (const act of activities) {
    const dateStr = act.start_date_local.slice(0, 10);
    const load = act.icu_training_load || 0;
    dailyLoad.set(dateStr, (dailyLoad.get(dateStr) ?? 0) + load);
  }
  const result: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = isoDateDaysBefore(frozenNow, i);
    result.push(dailyLoad.get(date) ?? 0);
  }
  return result;
}

function isoDateDaysBefore(isoNow: string, daysBefore: number): string {
  const datePart = isoNow.slice(0, 10);
  const [y, m, d] = datePart.split("-").map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() - daysBefore);
  return utc.toISOString().slice(0, 10);
}

// Python's `round(x, n)` uses banker's rounding (round-half-to-even) and
// diverges from `Math.round(x*10**n)/10**n` (round-half-up) for values
// exactly at the half boundary. Mirroring Python keeps the gate
// bit-identical on any future ACWR value that lands at the boundary.
function roundHalfEven(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const epsilon = 1e-9;
  if (diff < 0.5 - epsilon) return floor / factor;
  if (diff > 0.5 + epsilon) return (floor + 1) / factor;
  return (floor % 2 === 0 ? floor : floor + 1) / factor;
}
