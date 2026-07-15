import {
  changedIndices,
  cloneValidatedRepairStream,
  interpolateFinite,
  type CanonicalRepairStream,
  type RepairStageResult,
} from "./types.js";

const PLAUSIBLE_BPM = Object.freeze([35, 230] as const);

export const PULSE_WEAVE_PARAMS = Object.freeze({
  boundaryPolicy: "bounded-only",
  convergence: "fixed-point",
  flatlineBoundaryDeltaBpm: 5,
  flatlineMinSeconds: 10,
  interpolation: "linear",
  maxRepairSeconds: 30,
  plausibleBpm: PLAUSIBLE_BPM,
  zeroOrImplausibleMaxBpm: 30,
  zeroRunMinSeconds: 2,
} as const);

interface Run { readonly start: number; readonly end: number }

function consecutive(time: readonly number[], left: number, right: number): boolean {
  return time[right]! - time[left]! === 1;
}

function lowRuns(time: readonly number[], values: readonly (number | null)[]): Run[] {
  const runs: Run[] = [];
  let index = 0;
  while (index < values.length) {
    if (!(values[index] === null || values[index]! <= 30)) { index += 1; continue; }
    const start = index;
    while (index + 1 < values.length && consecutive(time, index, index + 1) && (values[index + 1] === null || values[index + 1]! <= 30)) index += 1;
    const end = index;
    if (time[end]! - time[start]! + 1 >= 2) runs.push({ start, end });
    index += 1;
  }
  return runs;
}

function flatlineRuns(time: readonly number[], values: readonly (number | null)[]): Run[] {
  const runs: Run[] = [];
  let index = 0;
  while (index < values.length) {
    if (values[index] === null) { index += 1; continue; }
    const start = index;
    const value = values[index];
    while (index + 1 < values.length && consecutive(time, index, index + 1) && values[index + 1] === value) index += 1;
    const end = index;
    if (time[end]! - time[start]! + 1 >= 10) runs.push({ start, end });
    index += 1;
  }
  return runs;
}

function plausible(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && value >= 35 && value <= 230;
}

function repairable(time: readonly number[], values: readonly (number | null)[], run: Run, flatline: boolean): boolean {
  const leftIndex = run.start - 1;
  const rightIndex = run.end + 1;
  if (leftIndex < 0 || rightIndex >= values.length) return false;
  if (!consecutive(time, leftIndex, run.start) || !consecutive(time, run.end, rightIndex)) return false;
  const left = values[leftIndex];
  const right = values[rightIndex];
  if (!plausible(left) || !plausible(right)) return false;
  const duration = time[run.end]! - time[run.start]! + 1;
  if (duration > 30) return false;
  if (flatline) {
    const value = values[run.start];
    if (value === null || Math.abs(left - value) < 5 || Math.abs(right - value) < 5) return false;
  }
  return true;
}

function sweep(time: readonly number[], values: readonly (number | null)[]): readonly (number | null)[] {
  const next = [...values];
  const candidates = [
    ...lowRuns(time, values).map((run) => ({ run, flatline: false })),
    ...flatlineRuns(time, values).map((run) => ({ run, flatline: true })),
  ];
  const seen = new Set<string>();
  for (const { run, flatline } of candidates) {
    const key = `${run.start}:${run.end}`;
    if (seen.has(key) || !repairable(time, values, run, flatline)) continue;
    seen.add(key);
    const leftIndex = run.start - 1;
    const rightIndex = run.end + 1;
    const left = values[leftIndex] as number;
    const right = values[rightIndex] as number;
    for (let index = run.start; index <= run.end; index += 1) {
      next[index] = interpolateFinite(left, right, (time[index]! - time[leftIndex]!) / (time[rightIndex]! - time[leftIndex]!));
    }
  }
  return next;
}

export function pulseWeave(stream: CanonicalRepairStream): RepairStageResult {
  const input = cloneValidatedRepairStream(stream);
  const channels: Record<string, readonly (number | null)[]> = Object.fromEntries(
    Object.entries(input.channels).map(([name, values]) => [name, [...values]]),
  );
  const before = channels.heart_rate;
  if (before === undefined) return { stream: { time: [...input.time], channels }, changes: [] };
  let current = [...before];
  while (true) {
    const next = [...sweep(input.time, current)];
    const changed = changedIndices(current, next);
    current = next;
    if (changed.length === 0) break;
  }
  channels.heart_rate = current;
  return {
    stream: { time: [...input.time], channels: Object.fromEntries(Object.entries(channels).map(([name, values]) => [name, [...values]])) },
    changes: [{ channel: "heart_rate", changedIndices: changedIndices(before, current) }],
  };
}
