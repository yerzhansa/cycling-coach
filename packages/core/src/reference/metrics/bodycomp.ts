/**
 * Reference layer — body-composition signals derived from the wellness
 * stream and the cycling FTP source.
 *
 * Currently houses `computeWeightSignal` only: a multi-field gated
 * emission summarising the trailing 28-day weight series. Each output
 * sub-field is independently gated (latest-14d, first-4/last-4 boundary
 * windows for the block trajectory, ≥4-in-7d average, ≥14-in-28d
 * least-squares slope) and **absent from the returned dict** when its
 * gate fails — `null` is reserved for the all-fail case where every
 * sub-field would be absent.
 *
 * The module is sized for the broader body-composition class (a future
 * lean-mass signal would land alongside) rather than just the W/kg block;
 * if no sibling metric materialises before another touch-up, rename to
 * `weight-signal.ts`.
 */

import {
  getCurrentFtpOutdoor,
  getEftp,
  getFtpHistoryIndoor,
  getFtpHistoryOutdoor,
  getWellnessExtendedWeight,
  type MetricInput,
} from "./metric-input.js";
import { isoToMs, parseIsoMs } from "./date-helpers.js";
import { pythonSum } from "./statistics.js";
import { roundHalfEven } from "./rounding.js";

const MS_PER_DAY = 86_400_000;
const BLOCK_WINDOW_DAYS = 28;
const BOUNDARY_WIDTH_DAYS = 4;

export type FtpSource = "tested" | "eftp";

/**
 * Trailing W/kg block trajectory plus weekly weight stats. Every field is
 * optional: a failed gate REMOVES the key (never writes `null`), so the
 * downstream layer treats absence as the "omit this section" signal.
 * The whole object is `null` when no gate fired.
 */
export interface WeightSignal {
  weight_latest_kg?: number;
  weight_latest_date?: string;
  wkg_current?: number;
  wkg_ftp_source?: FtpSource;
  ftp_setting_date?: string;
  wkg_block_start?: number;
  wkg_block_end?: number;
  wkg_block_delta?: number;
  weight_7d_avg_kg?: number;
  weight_28d_slope_kg_per_week?: number;
}

interface DatedWeight {
  dateMs: number;
  dateStr: string;
  weight: number;
}

// Pick the weigh-in whose date falls within [lowMs, highMs] and is closest
// to anchorMs (in calendar-day distance). Iterates newest-first with a
// strictly-less-than tiebreak so the first-seen (newest) row wins on a
// tied calendar distance — mirrors the upstream's `entries` ordering.
function nearestInRange(
  newestFirst: readonly DatedWeight[],
  lowMs: number,
  highMs: number,
  anchorMs: number,
): number | null {
  let best: number | null = null;
  let bestDist: number | null = null;
  for (const e of newestFirst) {
    if (e.dateMs < lowMs || e.dateMs > highMs) continue;
    const dist = Math.abs(Math.floor((e.dateMs - anchorMs) / MS_PER_DAY));
    if (bestDist === null || dist < bestDist) {
      best = e.weight;
      bestDist = dist;
    }
  }
  return best;
}

export function computeWeightSignal(
  input: MetricInput,
): WeightSignal | null {
  const wellness = getWellnessExtendedWeight(input);

  const todayStr = input.frozenNow.slice(0, 10);
  const todayMs = isoToMs(todayStr);

  // Collect dated weight entries — drop nulls, zeros, missing/malformed dates.
  const entries: DatedWeight[] = [];
  for (const w of wellness) {
    const wt = w.weight;
    if (wt === null || wt === undefined || wt === 0) continue;
    const dateStr = (w.id ?? "").slice(0, 10);
    if (!dateStr) continue;
    const ms = parseIsoMs(dateStr);
    if (ms === null) continue;
    entries.push({ dateMs: ms, dateStr, weight: wt });
  }

  if (entries.length === 0) return null;

  // Newest-first
  entries.sort((a, b) => b.dateMs - a.dateMs);

  const block: WeightSignal = {};

  // weight_latest_kg / weight_latest_date — latest weigh-in within 14 days.
  const latest = entries[0]!;
  const latestAgeDays = Math.floor((todayMs - latest.dateMs) / MS_PER_DAY);
  if (latestAgeDays >= 0 && latestAgeDays <= 14) {
    block.weight_latest_kg = roundHalfEven(latest.weight, 1);
    block.weight_latest_date = latest.dateStr;
  }

  // FTP source — tested cycling.ftp preferred, eFTP fallback. Indoor FTP
  // is unused in this metric per the upstream protocol (sync.py:2871
  // reads cycling.ftp = outdoor only). ftp_setting_date still falls back
  // to the indoor history newest entry when outdoor history is empty
  // (sync.py:2882-2890).
  const testedFtp = getCurrentFtpOutdoor(input);
  const eftp = getEftp(input);

  let ftpUsed: number | null = null;
  let ftpSource: FtpSource | null = null;
  let ftpSettingDate: string | null = null;

  if (testedFtp !== null && testedFtp !== 0) {
    ftpUsed = testedFtp;
    ftpSource = "tested";
    const outdoorDates = Object.keys(getFtpHistoryOutdoor(input))
      .slice()
      .sort()
      .reverse();
    const indoorDates = Object.keys(getFtpHistoryIndoor(input))
      .slice()
      .sort()
      .reverse();
    if (outdoorDates.length > 0) {
      ftpSettingDate = outdoorDates[0]!;
    } else if (indoorDates.length > 0) {
      ftpSettingDate = indoorDates[0]!;
    }
  } else if (eftp !== null && eftp !== 0) {
    ftpUsed = eftp;
    ftpSource = "eftp";
  }

  // wkg_current — needs weight_latest + an FTP source.
  if (
    block.weight_latest_kg !== undefined &&
    ftpUsed !== null &&
    block.weight_latest_kg > 0
  ) {
    block.wkg_current = roundHalfEven(ftpUsed / block.weight_latest_kg, 2);
    block.wkg_ftp_source = ftpSource!;
    if (ftpSettingDate !== null) {
      block.ftp_setting_date = ftpSettingDate;
    }
  }

  // Block trajectory: first-4 days of the trailing 28d window (anchored at
  // day -27) and last-4 days (anchored at today). Both endpoints use the
  // CURRENT FTP, so the delta isolates weight change across the window.
  const first4HighMs =
    todayMs - (BLOCK_WINDOW_DAYS - BOUNDARY_WIDTH_DAYS) * MS_PER_DAY;
  const first4LowMs = todayMs - (BLOCK_WINDOW_DAYS - 1) * MS_PER_DAY;
  const last4LowMs = todayMs - (BOUNDARY_WIDTH_DAYS - 1) * MS_PER_DAY;
  const last4HighMs = todayMs;

  const weightAtStart = nearestInRange(
    entries,
    first4LowMs,
    first4HighMs,
    first4LowMs,
  );
  const weightAtEnd = nearestInRange(
    entries,
    last4LowMs,
    last4HighMs,
    todayMs,
  );

  if (weightAtStart !== null && weightAtEnd !== null && ftpUsed !== null) {
    block.wkg_block_start = roundHalfEven(ftpUsed / weightAtStart, 2);
    block.wkg_block_end = roundHalfEven(ftpUsed / weightAtEnd, 2);
    block.wkg_block_delta = roundHalfEven(
      block.wkg_block_end - block.wkg_block_start,
      2,
    );
  }

  // weight_7d_avg_kg — ≥4 weigh-ins in the trailing 7 days.
  const sevenDCutoffMs = todayMs - 6 * MS_PER_DAY;
  const sevenDWeights = entries
    .filter((e) => e.dateMs >= sevenDCutoffMs)
    .map((e) => e.weight);
  if (sevenDWeights.length >= 4) {
    const avgKg = pythonSum(sevenDWeights) / sevenDWeights.length;
    block.weight_7d_avg_kg = roundHalfEven(avgKg, 1);
  }

  // weight_28d_slope_kg_per_week — least-squares slope over the trailing 28d,
  // multiplied by 7 to convert per-day → per-week. ≥14 weigh-ins required.
  // Mirrors sync.py:2942-2960's denom > 0 gate, which protects against the
  // degenerate case of all weigh-ins on a single day.
  const twentyEightDCutoffMs = todayMs - (BLOCK_WINDOW_DAYS - 1) * MS_PER_DAY;
  const slopePairs = entries.filter((e) => e.dateMs >= twentyEightDCutoffMs);
  if (slopePairs.length >= 14) {
    const n = slopePairs.length;
    const xs = slopePairs.map((e) =>
      Math.floor((e.dateMs - twentyEightDCutoffMs) / MS_PER_DAY),
    );
    const ys = slopePairs.map((e) => e.weight);
    const meanX = pythonSum(xs) / n;
    const meanY = pythonSum(ys) / n;
    const numTerms: number[] = [];
    const denTerms: number[] = [];
    for (let i = 0; i < n; i++) {
      const dx = xs[i]! - meanX;
      const dy = ys[i]! - meanY;
      numTerms.push(dx * dy);
      denTerms.push(dx * dx);
    }
    const num = pythonSum(numTerms);
    const den = pythonSum(denTerms);
    if (den > 0) {
      const slopeKgPerWeek = (num / den) * 7;
      block.weight_28d_slope_kg_per_week = roundHalfEven(slopeKgPerWeek, 3);
    }
  }

  if (Object.keys(block).length === 0) return null;
  return block;
}
