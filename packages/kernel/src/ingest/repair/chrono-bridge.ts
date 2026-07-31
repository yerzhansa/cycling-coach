import {
  cloneValidatedRepairStream,
  compareUnicodeCodePoints,
  interpolateFinite,
  type CanonicalRepairStream,
  type ChannelChanges,
  type RepairStageResult,
  type RepairValue,
} from "./types.js";

export const CHRONO_BRIDGE_PARAMS = Object.freeze({
  boundaryPolicy: "bounded-only",
  interpolation: "linear",
  maxMissingSeconds: 5,
} as const);

export function chronoBridge(stream: CanonicalRepairStream): RepairStageResult {
  const input = cloneValidatedRepairStream(stream);
  const names = Object.keys(input.channels).sort(compareUnicodeCodePoints);
  const time: number[] = [];
  const channels: Record<string, RepairValue[]> = Object.fromEntries(names.map((name) => [name, []]));
  const insertedIndices: number[] = [];

  for (let index = 0; index < input.time.length; index += 1) {
    time.push(input.time[index]!);
    for (const name of names) channels[name]!.push(input.channels[name]![index]!);
    if (index + 1 >= input.time.length) continue;
    const leftTime = input.time[index]!;
    const rightTime = input.time[index + 1]!;
    const missing = rightTime - leftTime - 1;
    if (!Number.isInteger(missing) || missing < 1 || missing > 5) continue;
    for (let offset = 1; offset <= missing; offset += 1) {
      const nextTime = leftTime + offset;
      insertedIndices.push(time.length);
      time.push(nextTime === 0 ? 0 : nextTime);
      for (const name of names) {
        const left = input.channels[name]![index]!;
        const right = input.channels[name]![index + 1]!;
        channels[name]!.push(
          left !== null && right !== null
            ? interpolateFinite(left, right, (nextTime - leftTime) / (rightTime - leftTime))
            : null,
        );
      }
    }
  }

  for (const name of names) {
    const values = channels[name]!;
    let index = 0;
    while (index < values.length) {
      if (values[index] !== null) {
        index += 1;
        continue;
      }
      const start = index;
      while (index < values.length && values[index] === null) index += 1;
      const end = index - 1;
      const leftIndex = start - 1;
      const rightIndex = end + 1;
      if (leftIndex < 0 || rightIndex >= values.length) continue;
      const left = values[leftIndex];
      const right = values[rightIndex];
      if (left === null || right === null) continue;
      const missingSeconds = time[rightIndex]! - time[leftIndex]! - 1;
      if (missingSeconds < 1 || missingSeconds > 5) continue;
      for (let fill = start; fill <= end; fill += 1) {
        values[fill] = interpolateFinite(
          left,
          right,
          (time[fill]! - time[leftIndex]!) / (time[rightIndex]! - time[leftIndex]!),
        );
      }
    }
  }

  const inserted = new Set(insertedIndices);
  const changes: ChannelChanges[] = [{ channel: "time", changedIndices: insertedIndices }];
  for (const name of names) {
    const indices: number[] = [];
    let sourceIndex = 0;
    for (let outputIndex = 0; outputIndex < time.length; outputIndex += 1) {
      const value = channels[name]![outputIndex]!;
      if (inserted.has(outputIndex)) {
        if (value !== null) indices.push(outputIndex);
      } else {
        if (value !== null && !Object.is(value, input.channels[name]![sourceIndex])) indices.push(outputIndex);
        sourceIndex += 1;
      }
    }
    changes.push({ channel: name, changedIndices: indices });
  }
  return { stream: { time: [...time], channels: Object.fromEntries(names.map((name) => [name, [...channels[name]!]])) }, changes };
}
