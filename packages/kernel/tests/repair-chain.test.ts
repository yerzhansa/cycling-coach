import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CHRONO_BRIDGE_PARAMS,
  PULSE_WEAVE_PARAMS,
  REPAIR_CHAIN_SLOTS,
  SUMMIT_GUARD_PARAMS,
  averageFinite,
  chronoBridge,
  pulseWeave,
  runRepairChain,
  summitGuard,
  summitGuardSweep,
  type CanonicalRepairStream,
} from "../src/ingest/repair/index.js";
import {
  canonicalRepairStreamArbitrary,
  chronoRepairProducingArbitrary,
  pulseRepairProducingArbitrary,
  summitRepairProducingArbitrary,
} from "./helpers/stream-arbitraries.js";

const finitePresent = (stream: CanonicalRepairStream) =>
  stream.time.every(Number.isFinite) && Object.values(stream.channels).every((values) => values.every((value) => value === null || Number.isFinite(value)));

describe("deterministic repair chain", () => {
  it("chronoBridge interpolates the pinned example and safely crosses maximum finite opposites", () => {
    expect(chronoBridge({ time: [0, 3], channels: { power: [100, 130], speed: [10, 13], heart_rate: [100, 103] } }).stream).toEqual({
      time: [0, 1, 2, 3], channels: { heart_rate: [100, 101, 102, 103], power: [100, 110, 120, 130], speed: [10, 11, 12, 13] },
    });
    const result = chronoBridge({ time: [0, 2], channels: { power: [Number.MAX_VALUE, -Number.MAX_VALUE] } });
    expect(result.stream.channels.power).toEqual([Number.MAX_VALUE, 0, -Number.MAX_VALUE]);
    expect(Object.is(result.stream.channels.power![1], -0)).toBe(false);
    expect(averageFinite(Number.MAX_VALUE, Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
  });

  it("chronoBridge obeys its timestamp boundary table", () => {
    expect(chronoBridge({ time: [0, 6], channels: { power: [0, 6] } }).stream.time).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(chronoBridge({ time: [0, 7], channels: { power: [0, 7] } }).stream.time).toEqual([0, 7]);
    expect(chronoBridge({ time: [0, 0.5], channels: { power: [0, 1] } }).stream.time).toEqual([0, 0.5]);
    expect(chronoBridge({ time: [0, 1, 2], channels: { power: [null, 1, null] } }).stream.channels.power).toEqual([null, 1, null]);
  });

  it("chronoBridge fills bounded existing null slots and logs final indices", () => {
    const result = chronoBridge({ time: [0, 1, 2, 3], channels: { power: [100, null, null, 130] } });
    expect(result.stream.channels.power).toEqual([100, 110, 120, 130]);
    expect(result.changes).toEqual([{ channel: "time", changedIndices: [] }, { channel: "power", changedIndices: [1, 2] }]);
  });

  it("validates every public input and normalizes negative zero with scalar channel order", () => {
    const sparseTime = [0, 1, 2]; delete sparseTime[1];
    const sparseChannel = [1, 2, 3]; delete sparseChannel[1];
    const invalid: unknown[] = [
      { time: [], channels: {} }, { time: [0, 0], channels: {} }, { time: [1, 0], channels: {} },
      { time: [0, Infinity], channels: {} }, { time: [0], channels: { "": [1] } },
      { time: [0], channels: { "\ud800": [1] } }, { time: [0, 1], channels: { power: [1] } },
      { time: [0], channels: { power: [undefined] } }, { time: sparseTime, channels: {} },
      { time: [0, 1, 2], channels: { power: sparseChannel } }, { time: [0], channels: { power: [NaN] } },
      { time: [0], channels: { power: [Infinity] } }, { time: [0], channels: { power: [-Infinity] } },
      { time: [0], channels: { power: [1n] } }, { time: [0], channels: { power: [() => 1] } },
      { time: [0], channels: { power: [Symbol("x")] } },
    ];
    for (const value of invalid) {
      expect(() => chronoBridge(value as CanonicalRepairStream)).toThrow();
      expect(() => summitGuard(value as CanonicalRepairStream)).toThrow();
      expect(() => pulseWeave(value as CanonicalRepairStream)).toThrow();
    }
    const result = chronoBridge({ time: [-0, 1], channels: { "\u{1F600}": [-0, 1], "\uE000": [-0, 1] } });
    expect(Object.is(result.stream.time[0], -0)).toBe(false);
    expect(Object.is(result.stream.channels["\uE000"]![0], -0)).toBe(false);
    expect(result.changes.map((change) => change.channel)).toEqual(["time", "\uE000", "\u{1F600}"]);
    const protoChannels = Object.create(null) as Record<string, readonly (number | null)[]>;
    protoChannels.__proto__ = [1, 2];
    const protoResult = chronoBridge({ time: [0, 1], channels: protoChannels });
    expect(Object.prototype.hasOwnProperty.call(protoResult.stream.channels, "__proto__")).toBe(true);
    expect(protoResult.stream.channels.__proto__).toEqual([1, 2]);
    for (const change of result.changes) for (let index = 0; index < change.changedIndices.length; index += 1) {
      expect(Number.isSafeInteger(change.changedIndices[index])).toBe(true);
      expect(change.changedIndices[index]).toBeGreaterThanOrEqual(0);
      if (index > 0) expect(change.changedIndices[index]).toBeGreaterThan(change.changedIndices[index - 1]!);
    }
  });

  it("summitGuard replaces spikes and rejects incomplete or null windows while retaining cutoff equality", () => {
    const changed = summitGuard({ time: [0, 1, 2, 3, 4, 5, 6], channels: { power: [100, 100, 100, 1000, 100, 100, 100], speed: [10, 10, 10, 20, 10, 10, 10] } });
    expect(changed.stream.channels).toEqual({ power: [100, 100, 100, 100, 100, 100, 100], speed: [10, 10, 10, 10, 10, 10, 10] });
    expect(summitGuard({ time: [0, 1, 2, 3, 4, 5, 6], channels: { power: [100, 100, 100, 150, 100, 100, 100] } }).changes[0]!.changedIndices).toEqual([]);
    expect(summitGuard({ time: [0, 1, 2, 3, 4, 5], channels: { power: [1000, 100, 100, 100, 100, 100] } }).changes[0]!.changedIndices).toEqual([]);
    expect(summitGuard({ time: [0, 1, 2, 3, 4, 5, 6], channels: { power: [100, 100, 100, null, 100, 100, 100] } }).changes[0]!.changedIndices).toEqual([]);
    expect(summitGuard({ time: [0, 1, 2, 3, 4, 5, 6], channels: { power: [100, null, 100, 1000, 100, 100, 100] } }).changes[0]!.changedIndices).toEqual([]);
  });

  it("summitGuard preserves the exact seventy-index characterization", () => {
    const time = Array.from({ length: 490 }, (_, index) => index);
    const spikes = Array.from({ length: 70 }, (_, index) => 3 + 7 * index);
    const set = new Set(spikes);
    const result = summitGuard({ time, channels: { power: time.map((index) => set.has(index) ? 1000 : 200), speed: time.map((index) => set.has(index) ? 20 : 10) } });
    expect(result.changes).toEqual([{ channel: "power", changedIndices: spikes }, { channel: "speed", changedIndices: spikes }]);
    expect(result.stream.channels.power).toEqual(time.map(() => 200));
    expect(result.stream.channels.speed).toEqual(time.map(() => 10));
  });

  it("summitGuard performs the exact synchronous multi-sweep sequence", () => {
    const start = [100, 100, 100, 1000, 500, 100, 1000, 0, 0, 100, 100, 100];
    const first = summitGuardSweep(start, 50);
    expect(first.changedIndices).toEqual([3, 6, 8]);
    expect(first.values).toEqual([100, 100, 100, 100, 500, 100, 100, 0, 100, 100, 100, 100]);
    const second = summitGuardSweep(first.values, 50);
    expect(second.changedIndices).toEqual([4, 7]);
    expect(second.values).toEqual(Array(12).fill(100));
    expect(summitGuardSweep(second.values, 50).changedIndices).toEqual([]);
    const result = summitGuard({ time: Array.from({ length: 12 }, (_, index) => index), channels: { power: start } });
    expect(result.changes[0]!.changedIndices).toEqual([3, 4, 6, 7, 8]);
    expect(summitGuard(result.stream).changes[0]!.changedIndices).toEqual([]);
  });

  it("pulseWeave repairs varying and mixed low runs", () => {
    expect(pulseWeave({ time: [0, 1, 2, 3], channels: { heart_rate: [100, 0, 10, 103] } }).stream.channels.heart_rate).toEqual([100, 101, 102, 103]);
    expect(pulseWeave({ time: [0, 1, 2, 3], channels: { heart_rate: [100, null, 10, 103] } }).stream.channels.heart_rate).toEqual([100, 101, 102, 103]);
  });

  it("pulseWeave repairs a bounded ten-second flatline", () => {
    const result = pulseWeave({ time: Array.from({ length: 12 }, (_, index) => index), channels: { heart_rate: [100, ...Array(10).fill(120), 140] } });
    expect(result.changes[0]!.changedIndices).toEqual(Array.from({ length: 10 }, (_, index) => index + 1));
    expect(result.stream.channels.heart_rate![1]).toBeCloseTo(100 + 40 / 11);
  });

  it("pulseWeave obeys all duration, bound, continuity, and low-threshold boundaries", () => {
    const bounded = (count: number, value: number | null, right = 140) => ({ time: Array.from({ length: count + 2 }, (_, index) => index), channels: { heart_rate: [100, ...Array(count).fill(value), right] } });
    expect(pulseWeave(bounded(1, 30)).changes[0]!.changedIndices).toEqual([]);
    expect(pulseWeave(bounded(2, 30)).changes[0]!.changedIndices).toEqual([1, 2]);
    expect(pulseWeave(bounded(9, 120)).changes[0]!.changedIndices).toEqual([]);
    expect(pulseWeave(bounded(10, 120)).changes[0]!.changedIndices).toHaveLength(10);
    expect(pulseWeave(bounded(30, 0)).changes[0]!.changedIndices).toHaveLength(30);
    expect(pulseWeave(bounded(31, 0)).changes[0]!.changedIndices).toEqual([]);
    expect(pulseWeave(bounded(2, 31)).changes[0]!.changedIndices).toEqual([]);
    expect(pulseWeave({ time: [0, 1, 2], channels: { heart_rate: [0, 0, 100] } }).changes[0]!.changedIndices).toEqual([]);
    expect(pulseWeave(bounded(2, 0, 20)).changes[0]!.changedIndices).toEqual([]);
    expect(pulseWeave({ time: [0, 1, 3, 4], channels: { heart_rate: [100, 0, 0, 140] } }).changes[0]!.changedIndices).toEqual([]);
  });

  it("pins exact parameter JSON and six-slot order", () => {
    expect(JSON.stringify(CHRONO_BRIDGE_PARAMS)).toBe('{"boundaryPolicy":"bounded-only","interpolation":"linear","maxMissingSeconds":5}');
    expect(JSON.stringify(SUMMIT_GUARD_PARAMS)).toBe('{"convergence":"fixed-point","madScale":1.4826,"powerFloorWatts":50,"speedFloorMps":2,"thresholdScaledMad":3,"windowSamples":7}');
    expect(JSON.stringify(PULSE_WEAVE_PARAMS)).toBe('{"boundaryPolicy":"bounded-only","convergence":"fixed-point","flatlineBoundaryDeltaBpm":5,"flatlineMinSeconds":10,"interpolation":"linear","maxRepairSeconds":30,"plausibleBpm":[35,230],"zeroOrImplausibleMaxBpm":30,"zeroRunMinSeconds":2}');
    expect(REPAIR_CHAIN_SLOTS).toEqual([
      { slot: "010", fixer: "chronoBridge" }, { slot: "020", fixer: null, reserved: "reserved-w5c-a" },
      { slot: "030", fixer: "summitGuard" }, { slot: "040", fixer: null, reserved: "reserved-w5c-b" },
      { slot: "050", fixer: "pulseWeave" }, { slot: "060", fixer: null, reserved: "reserved-w5c-c" },
    ]);
    expect(Object.isFrozen(PULSE_WEAVE_PARAMS)).toBe(true);
    expect(Object.isFrozen(PULSE_WEAVE_PARAMS.plausibleBpm)).toBe(true);
    expect(Object.isFrozen(REPAIR_CHAIN_SLOTS)).toBe(true);
    expect(REPAIR_CHAIN_SLOTS.every(Object.isFrozen)).toBe(true);
    expect(() => { (PULSE_WEAVE_PARAMS.plausibleBpm as unknown as number[])[0] = 0; }).toThrow(TypeError);
    expect(() => { (REPAIR_CHAIN_SLOTS[0] as { slot: string }).slot = "999"; }).toThrow(TypeError);
    expect(JSON.stringify(PULSE_WEAVE_PARAMS)).toBe('{"boundaryPolicy":"bounded-only","convergence":"fixed-point","flatlineBoundaryDeltaBpm":5,"flatlineMinSeconds":10,"interpolation":"linear","maxRepairSeconds":30,"plausibleBpm":[35,230],"zeroOrImplausibleMaxBpm":30,"zeroRunMinSeconds":2}');
    expect(REPAIR_CHAIN_SLOTS[0]).toEqual({ slot: "010", fixer: "chronoBridge" });
  });

  it("keeps each stage pure, finite, and deeply idempotent", { timeout: 30_000 }, () => {
    fc.assert(fc.property(canonicalRepairStreamArbitrary, (stream) => {
      const before = structuredClone(stream);
      for (const repair of [chronoBridge, summitGuard, pulseWeave]) {
        const once = repair(stream).stream;
        expect(stream).toEqual(before);
        expect(finitePresent(once)).toBe(true);
        expect(repair(once).stream).toEqual(once);
        expect(once).not.toBe(stream);
      }
    }), { numRuns: 1000 });
  });

  it("nonvacuously produces chronoBridge changes", { timeout: 30_000 }, () => {
    fc.assert(fc.property(chronoRepairProducingArbitrary, (stream) => {
      const result = chronoBridge(stream);
      expect(result.stream.time).toHaveLength(7);
      expect(result.changes[0]).toEqual({ channel: "time", changedIndices: [1, 2, 3, 4, 5] });
    }), { numRuns: 1000 });
  });

  it("nonvacuously produces summitGuard changes", { timeout: 30_000 }, () => {
    fc.assert(fc.property(summitRepairProducingArbitrary, (stream) => {
      const result = summitGuard(stream);
      const channel = Object.keys(stream.channels)[0]!;
      expect(result.changes).toEqual([{ channel, changedIndices: [3] }]);
      expect(result.stream.channels[channel]![3]).toBe(stream.channels[channel]![0]);
    }), { numRuns: 1000 });
  });

  it("nonvacuously produces pulseWeave changes", { timeout: 30_000 }, () => {
    fc.assert(fc.property(pulseRepairProducingArbitrary, (stream) => {
      const result = pulseWeave(stream);
      expect(result.changes[0]!.changedIndices.length).toBeGreaterThan(0);
      expect(result.stream.channels.heart_rate!.every((value) => value !== null && Number.isFinite(value))).toBe(true);
    }), { numRuns: 1000 });
  });

  it("keeps the composed chain pure, finite, scalar-ordered, and deeply idempotent", { timeout: 30_000 }, () => {
    fc.assert(fc.property(canonicalRepairStreamArbitrary, (stream) => {
      const before = structuredClone(stream);
      const once = runRepairChain(stream);
      expect(stream).toEqual(before);
      expect(finitePresent(once.stream)).toBe(true);
      expect(runRepairChain(once.stream).stream).toEqual(once.stream);
      expect(once.logs).toHaveLength(3);
      expect(once.logs[0]!.changes.map((change) => change.channel)).toEqual(["time", "cadence", "heart_rate", "power", "speed"]);
    }), { numRuns: 1000 });
  });
});
