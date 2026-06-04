import { describe, expect, it } from "vitest";

import type { FixtureShape, WellnessDay } from "../schemas/inputs.js";
import type { MetricInput } from "./metric-input.js";
import {
  computeEftp,
  computePMax,
  computePowerModelSource,
  computeVo2max,
  computeWPrime,
  computeWPrimeKj,
} from "./power-model.js";

const FROZEN_NOW = "2026-06-04T12:00:00";

interface SportInfoRow {
  type: string;
  eftp?: number | null;
  wPrime?: number | null;
  pMax?: number | null;
}

interface WellnessRowInput {
  date: string;
  sportInfo?: SportInfoRow[];
  vo2max?: number | null;
}

function wellness(rows: WellnessRowInput[]): WellnessDay[] {
  return rows.map((r) => ({
    id: r.date,
    weight: null,
    restingHR: null,
    hrv: null,
    sleepSecs: null,
    sleepQuality: null,
    ...(r.sportInfo !== undefined ? { sportInfo: r.sportInfo } : {}),
    ...(r.vo2max !== undefined ? { vo2max: r.vo2max } : {}),
  })) as WellnessDay[];
}

function fixture(partial: Partial<FixtureShape>): FixtureShape {
  return {
    activities: [],
    wellness: [],
    ftp_history: [],
    ...partial,
  } as unknown as FixtureShape;
}

function input(f: FixtureShape, frozenNow = FROZEN_NOW): MetricInput {
  return { fixture: f, frozenNow };
}

// The athlete-key carrier the harness gates the live power-model pipeline on.
const ATHLETE = { sportSettings: [] } as unknown as FixtureShape["athlete"];

describe("power-model passthroughs — athlete gate", () => {
  it("returns null for every key when the fixture carries no athlete", () => {
    const f = fixture({
      athlete: undefined,
      wellness: wellness([
        {
          date: "2026-06-04",
          sportInfo: [{ type: "Ride", eftp: 200, wPrime: 13882, pMax: 727 }],
          vo2max: 58,
        },
      ]),
    });
    expect(computeEftp(input(f))).toBeNull();
    expect(computeWPrime(input(f))).toBeNull();
    expect(computeWPrimeKj(input(f))).toBeNull();
    expect(computePMax(input(f))).toBeNull();
    expect(computePowerModelSource(input(f))).toBeNull();
    expect(computeVo2max(input(f))).toBeNull();
  });

  it("activates the pipeline when athlete is present", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        {
          date: "2026-06-04",
          sportInfo: [{ type: "Ride", eftp: 200, wPrime: 13882, pMax: 727 }],
          vo2max: 58,
        },
      ]),
    });
    expect(computeEftp(input(f))).toBe(200);
    expect(computeWPrime(input(f))).toBe(13882);
    expect(computeWPrimeKj(input(f))).toBe(13.9);
    expect(computePMax(input(f))).toBe(727);
    expect(computePowerModelSource(input(f))).toBe("wellness.sportInfo");
    expect(computeVo2max(input(f))).toBe(58);
  });
});

describe("power-model passthroughs — sportInfo Ride selection", () => {
  it("finds the first Ride dict, skipping non-Ride sports", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        {
          date: "2026-06-04",
          sportInfo: [
            { type: "Run", eftp: 999 },
            { type: "Ride", eftp: 250, wPrime: 20000, pMax: 900 },
            { type: "Ride", eftp: 111 },
          ],
        },
      ]),
    });
    expect(computeEftp(input(f))).toBe(250);
    expect(computePMax(input(f))).toBe(900);
    expect(computePowerModelSource(input(f))).toBe("wellness.sportInfo");
  });

  it("reports source 'unavailable' when no Ride dict is present", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        { date: "2026-06-04", sportInfo: [{ type: "Run", eftp: 250 }] },
      ]),
    });
    expect(computePowerModelSource(input(f))).toBe("unavailable");
    expect(computeEftp(input(f))).toBeNull();
    expect(computeWPrime(input(f))).toBeNull();
  });

  it("reports source 'unavailable' when sportInfo is empty", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([{ date: "2026-06-04", sportInfo: [] }]),
    });
    expect(computePowerModelSource(input(f))).toBe("unavailable");
  });

  it("reports source 'unavailable' when the row has no sportInfo key", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([{ date: "2026-06-04" }]),
    });
    expect(computePowerModelSource(input(f))).toBe("unavailable");
    expect(computeEftp(input(f))).toBeNull();
  });
});

describe("power-model passthroughs — truthiness gates", () => {
  it("maps a 0 scalar to null (Python falsy), keeping source populated", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        {
          date: "2026-06-04",
          sportInfo: [{ type: "Ride", eftp: 0, wPrime: 0, pMax: 0 }],
        },
      ]),
    });
    expect(computeEftp(input(f))).toBeNull();
    expect(computeWPrime(input(f))).toBeNull();
    expect(computeWPrimeKj(input(f))).toBeNull();
    expect(computePMax(input(f))).toBeNull();
    expect(computePowerModelSource(input(f))).toBe("wellness.sportInfo");
  });

  it("maps an absent/null scalar to null independently per field", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        {
          date: "2026-06-04",
          sportInfo: [{ type: "Ride", eftp: 240, wPrime: null }],
        },
      ]),
    });
    expect(computeEftp(input(f))).toBe(240);
    expect(computeWPrime(input(f))).toBeNull();
    expect(computeWPrimeKj(input(f))).toBeNull();
    expect(computePMax(input(f))).toBeNull();
  });
});

describe("power-model passthroughs — Python round semantics", () => {
  it("rounds eftp to one decimal with banker's rounding", () => {
    // round(240.25, 1) → 240.2 (tie to even); round(240.35, 1) → 240.3 on the
    // true double (240.35 stored just below). Matches Python's round().
    const mk = (e: number) =>
      fixture({
        athlete: ATHLETE,
        wellness: wellness([
          { date: "2026-06-04", sportInfo: [{ type: "Ride", eftp: e }] },
        ]),
      });
    expect(computeEftp(input(mk(240.25)))).toBe(240.2);
    expect(computeEftp(input(mk(173.67642)))).toBe(173.7);
  });

  it("rounds w_prime to the nearest integer (single-arg round)", () => {
    const mk = (w: number) =>
      fixture({
        athlete: ATHLETE,
        wellness: wellness([
          { date: "2026-06-04", sportInfo: [{ type: "Ride", wPrime: w }] },
        ]),
      });
    // round(13882.4) → 13882; round(13882.5) → 13882 (tie to even).
    expect(computeWPrime(input(mk(13882.4)))).toBe(13882);
    expect(computeWPrime(input(mk(13882.5)))).toBe(13882);
    expect(computeWPrime(input(mk(13883.5)))).toBe(13884);
  });

  it("derives w_prime_kj as round(w_prime / 1000, 1)", () => {
    const mk = (w: number) =>
      fixture({
        athlete: ATHLETE,
        wellness: wellness([
          { date: "2026-06-04", sportInfo: [{ type: "Ride", wPrime: w }] },
        ]),
      });
    expect(computeWPrimeKj(input(mk(13882)))).toBe(13.9);
    expect(computeWPrimeKj(input(mk(20000)))).toBe(20);
    // 12450/1000 = 12.45 stored just below 12.45, so round(_, 1) → 12.4.
    expect(computeWPrimeKj(input(mk(12450)))).toBe(12.4);
  });

  it("rounds p_max to the nearest integer", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        { date: "2026-06-04", sportInfo: [{ type: "Ride", pMax: 726.6 }] },
      ]),
    });
    expect(computePMax(input(f))).toBe(727);
  });
});

describe("power-model passthroughs — today_wellness selection", () => {
  it("uses the latest in-window wellness row, not fixture order", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        { date: "2026-06-04", sportInfo: [{ type: "Ride", eftp: 200 }], vo2max: 58 },
        { date: "2026-05-20", sportInfo: [{ type: "Ride", eftp: 182 }], vo2max: 46 },
      ]),
    });
    expect(computeEftp(input(f))).toBe(200);
    expect(computeVo2max(input(f))).toBe(58);
  });

  it("picks the max id even when rows are out of order", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        { date: "2026-05-20", sportInfo: [{ type: "Ride", eftp: 182 }] },
        { date: "2026-06-04", sportInfo: [{ type: "Ride", eftp: 200 }] },
        { date: "2026-05-30", sportInfo: [{ type: "Ride", eftp: 185 }] },
      ]),
    });
    expect(computeEftp(input(f))).toBe(200);
  });

  it("excludes rows outside the 28-day window", () => {
    // frozenNow 2026-06-04 → window oldest is 2026-05-08. A 2026-05-01 row
    // (with a higher eftp) must be excluded; the in-window 2026-05-10 row wins.
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        { date: "2026-05-01", sportInfo: [{ type: "Ride", eftp: 999 }] },
        { date: "2026-05-10", sportInfo: [{ type: "Ride", eftp: 190 }] },
      ]),
    });
    expect(computeEftp(input(f))).toBe(190);
  });

  it("reports 'unavailable' source when no row falls in the window", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        { date: "2026-05-01", sportInfo: [{ type: "Ride", eftp: 200 }], vo2max: 58 },
      ]),
    });
    expect(computePowerModelSource(input(f))).toBe("unavailable");
    expect(computeEftp(input(f))).toBeNull();
    expect(computeVo2max(input(f))).toBeNull();
  });
});

describe("power-model passthroughs — vo2max", () => {
  it("passes through vo2max from the latest row", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        { date: "2026-06-04", sportInfo: [{ type: "Ride", eftp: 200 }], vo2max: 58 },
      ]),
    });
    expect(computeVo2max(input(f))).toBe(58);
  });

  it("is null when the latest row has no vo2max — independent of sportInfo", () => {
    const f = fixture({
      athlete: ATHLETE,
      wellness: wellness([
        { date: "2026-06-04", sportInfo: [{ type: "Ride", eftp: 200 }] },
      ]),
    });
    expect(computeVo2max(input(f))).toBeNull();
    // sportInfo still resolves — vo2max gating is independent.
    expect(computeEftp(input(f))).toBe(200);
  });
});
