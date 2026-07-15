import {
  averageFinite,
  changedIndices,
  cloneValidatedRepairStream,
  finiteAbsDifference,
  finiteScaledMad,
  type CanonicalRepairStream,
  type RepairStageResult,
} from "./types.js";

export const SUMMIT_GUARD_PARAMS = Object.freeze({
  convergence: "fixed-point",
  madScale: 1.4826,
  powerFloorWatts: 50,
  speedFloorMps: 2,
  thresholdScaledMad: 3,
  windowSamples: 7,
} as const);

export function medianFinite(values: readonly number[]): number {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("finite nonempty population required");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : averageFinite(sorted[middle - 1]!, sorted[middle]!);
}

export interface SummitSweepResult {
  readonly values: readonly (number | null)[];
  readonly changedIndices: readonly number[];
}

export function summitGuardSweep(
  values: readonly (number | null)[],
  floor: number,
): SummitSweepResult {
  const next = [...values];
  const changed: number[] = [];
  for (let index = 3; index <= values.length - 4; index += 1) {
    const window = values.slice(index - 3, index + 4);
    if (window.some((value) => value === null)) continue;
    const finiteWindow = window as number[];
    const median = medianFinite(finiteWindow);
    const mad = medianFinite(finiteWindow.map((value) => finiteAbsDifference(value, median)));
    const current = values[index] as number;
    const cutoff = Math.max(floor, finiteScaledMad(mad));
    if (finiteAbsDifference(current, median) > cutoff) {
      next[index] = median === 0 ? 0 : median;
      changed.push(index);
    }
  }
  return { values: next, changedIndices: changed };
}

export function summitGuard(stream: CanonicalRepairStream): RepairStageResult {
  const input = cloneValidatedRepairStream(stream);
  const channels: Record<string, readonly (number | null)[]> = Object.fromEntries(
    Object.entries(input.channels).map(([name, values]) => [name, [...values]]),
  );
  const changes = [];
  for (const [name, floor] of [["power", 50], ["speed", 2]] as const) {
    if (!(name in channels)) continue;
    const before = [...channels[name]!];
    let current = before;
    while (true) {
      const sweep = summitGuardSweep(current, floor);
      current = [...sweep.values];
      if (sweep.changedIndices.length === 0) break;
    }
    channels[name] = current;
    changes.push({ channel: name, changedIndices: changedIndices(before, current) });
  }
  return {
    stream: { time: [...input.time], channels: Object.fromEntries(Object.entries(channels).map(([name, values]) => [name, [...values]])) },
    changes,
  };
}
