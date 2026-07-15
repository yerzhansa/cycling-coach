import fc from "fast-check";
import type { CanonicalRepairStream } from "../../src/ingest/repair/types.js";

const maybeFinite = (minimum: number, maximum: number) => fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 9, arbitrary: fc.double({ min: minimum, max: maximum, noNaN: true, noDefaultInfinity: true }).map((value) => value === 0 ? 0 : value) },
);

export const canonicalRepairStreamArbitrary: fc.Arbitrary<CanonicalRepairStream> = fc.integer({ min: 7, max: 40 }).chain((length) =>
  fc.tuple(
    fc.integer({ min: -1000, max: 1000 }),
    fc.array(fc.constantFrom(0.5, 1, 2, 6), { minLength: length - 1, maxLength: length - 1 }),
    fc.array(maybeFinite(-1000, 2000), { minLength: length, maxLength: length }),
    fc.array(maybeFinite(-100, 200), { minLength: length, maxLength: length }),
    fc.array(maybeFinite(0, 260), { minLength: length, maxLength: length }),
    fc.array(maybeFinite(0, 300), { minLength: length, maxLength: length }),
  ).map(([first, deltas, power, speed, heartRate, cadence]) => {
    const time = [first];
    for (const delta of deltas) time.push(time[time.length - 1]! + delta);
    return { time, channels: { power, speed, heart_rate: heartRate, cadence } };
  }),
);

export const chronoRepairProducingArbitrary = fc.tuple(
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
).map(([left, right]) => ({ time: [0, 6], channels: { power: [left, right] } }));

export const summitRepairProducingArbitrary = fc.tuple(
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.constantFrom("power" as const, "speed" as const),
).map(([baseline, channel]) => ({
  time: [0, 1, 2, 3, 4, 5, 6],
  channels: { [channel]: [baseline, baseline, baseline, baseline + (channel === "power" ? 100 : 10), baseline, baseline, baseline] },
}));

export const pulseRepairProducingArbitrary = fc.tuple(
  fc.integer({ min: 35, max: 230 }),
  fc.integer({ min: 35, max: 230 }),
).map(([left, right]) => ({ time: [0, 1, 2, 3], channels: { heart_rate: [left, 0, 10, right] } }))
  .filter((stream) => {
    const left = stream.channels.heart_rate[0]!;
    const right = stream.channels.heart_rate[3]!;
    return left + (right - left) / 3 !== 0 || left + 2 * (right - left) / 3 !== 10;
  });
