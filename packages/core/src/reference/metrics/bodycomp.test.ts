import { describe, expect, it } from "vitest";

import type { FixtureShape, WellnessDay } from "../schemas/inputs.js";
import { computeWeightSignal } from "./bodycomp.js";
import type { MetricInput } from "./metric-input.js";

const FROZEN_NOW = "2026-05-10T12:00:00";
const TODAY = "2026-05-10";

function ymdDaysBefore(daysBefore: number): string {
  const [y, m, d] = TODAY.split("-").map(Number) as [number, number, number];
  const ms = Date.UTC(y, m - 1, d) - daysBefore * 86_400_000;
  const dt = new Date(ms);
  const yy = String(dt.getUTCFullYear()).padStart(4, "0");
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function wellness(rows: { date: string; weight: number | null }[]): WellnessDay[] {
  return rows.map((r) => ({
    id: r.date,
    weight: r.weight,
    restingHR: null,
    hrv: null,
    sleepSecs: null,
    sleepQuality: null,
  })) as WellnessDay[];
}

function fixture(
  partial: Partial<FixtureShape> & { eftp?: number },
): FixtureShape {
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

describe("computeWeightSignal", () => {
  it("returns null when no weight entries exist", () => {
    expect(
      computeWeightSignal(
        input(fixture({ wellness: wellness([]) })),
      ),
    ).toBeNull();
  });

  it("returns null when all weight entries are null or zero", () => {
    expect(
      computeWeightSignal(
        input(
          fixture({
            wellness: wellness([
              { date: TODAY, weight: null },
              { date: ymdDaysBefore(1), weight: 0 },
            ]),
          }),
        ),
      ),
    ).toBeNull();
  });

  it("skips entries with malformed dates", () => {
    const f = fixture({
      wellness: [
        { id: "garbage", weight: 70 } as WellnessDay,
        { id: "2026-02-30", weight: 70 } as WellnessDay, // calendar-invalid
      ],
    });
    expect(computeWeightSignal(input(f))).toBeNull();
  });

  describe("weight_latest", () => {
    it("emits both fields when latest is within 14 days", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: ymdDaysBefore(14), weight: 71.5 }]),
          }),
        ),
      );
      expect(r?.weight_latest_kg).toBe(71.5);
      expect(r?.weight_latest_date).toBe(ymdDaysBefore(14));
    });

    it("omits weight_latest_kg when staleness exceeds 14 days", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: ymdDaysBefore(15), weight: 71.5 }]),
          }),
        ),
      );
      expect(r).toBeNull(); // no other gates passed → whole block null
    });

    it("rounds to 1dp via banker's rounding", () => {
      // 71.25 → half-to-even → 71.2
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: TODAY, weight: 71.25 }]),
          }),
        ),
      );
      expect(r?.weight_latest_kg).toBe(71.2);
    });
  });

  describe("wkg_current — FTP source resolution", () => {
    it("uses tested FTP when current_ftp_outdoor is set", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: TODAY, weight: 70.0 }]),
            current_ftp_outdoor: 280,
          }),
        ),
      );
      expect(r?.wkg_current).toBe(4);
      expect(r?.wkg_ftp_source).toBe("tested");
    });

    it("falls back to eftp when tested FTP is absent", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: TODAY, weight: 70.0 }]),
            eftp: 245,
          }),
        ),
      );
      expect(r?.wkg_current).toBe(3.5);
      expect(r?.wkg_ftp_source).toBe("eftp");
    });

    it("falls back to eftp when tested FTP is zero", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: TODAY, weight: 70.0 }]),
            current_ftp_outdoor: 0,
            eftp: 245,
          }),
        ),
      );
      expect(r?.wkg_ftp_source).toBe("eftp");
    });

    it("does NOT cross-read indoor FTP for the tested source", () => {
      // Only current_ftp_indoor present → tested branch should NOT fire.
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: TODAY, weight: 70.0 }]),
            current_ftp_indoor: 280,
          }),
        ),
      );
      expect(r?.wkg_current).toBeUndefined();
      expect(r?.wkg_ftp_source).toBeUndefined();
    });

    it("emits ftp_setting_date from outdoor history newest entry", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: TODAY, weight: 70.0 }]),
            current_ftp_outdoor: 280,
            ftp_history_outdoor: {
              "2026-01-01": 250,
              "2026-04-15": 280,
              "2026-03-15": 270,
            },
          }),
        ),
      );
      expect(r?.ftp_setting_date).toBe("2026-04-15");
    });

    it("falls back to indoor history when outdoor is empty", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: TODAY, weight: 70.0 }]),
            current_ftp_outdoor: 280,
            ftp_history_indoor: {
              "2026-02-01": 270,
              "2026-04-01": 280,
            },
          }),
        ),
      );
      expect(r?.ftp_setting_date).toBe("2026-04-01");
    });

    it("omits ftp_setting_date when neither history is populated", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: TODAY, weight: 70.0 }]),
            current_ftp_outdoor: 280,
          }),
        ),
      );
      expect(r?.wkg_current).toBe(4);
      expect(r?.ftp_setting_date).toBeUndefined();
    });

    it("omits wkg_current when no FTP source resolves", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([{ date: TODAY, weight: 70.0 }]),
          }),
        ),
      );
      expect(r?.weight_latest_kg).toBe(70);
      expect(r?.wkg_current).toBeUndefined();
    });
  });

  describe("wkg_block_* — boundary windows", () => {
    it("emits the block trio when both boundary windows are populated", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([
              // First-4 window [today-27, today-24]
              { date: ymdDaysBefore(25), weight: 72.0 },
              // Last-4 window [today-3, today]
              { date: TODAY, weight: 70.0 },
            ]),
            current_ftp_outdoor: 280,
          }),
        ),
      );
      expect(r?.wkg_block_start).toBe(3.89); // 280/72.0
      expect(r?.wkg_block_end).toBe(4); // 280/70.0
      expect(r?.wkg_block_delta).toBe(0.11);
    });

    it("omits block trio when first-4 window is empty", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([
              { date: ymdDaysBefore(20), weight: 72.0 }, // OUTSIDE first-4
              { date: TODAY, weight: 70.0 },
            ]),
            current_ftp_outdoor: 280,
          }),
        ),
      );
      expect(r?.wkg_block_start).toBeUndefined();
      expect(r?.wkg_block_end).toBeUndefined();
    });

    it("omits block trio when last-4 window is empty", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([
              { date: ymdDaysBefore(25), weight: 72.0 },
              { date: ymdDaysBefore(5), weight: 70.0 }, // OUTSIDE last-4
            ]),
            current_ftp_outdoor: 280,
          }),
        ),
      );
      expect(r?.wkg_block_start).toBeUndefined();
    });
  });

  describe("weight_7d_avg_kg", () => {
    it("emits when ≥4 weigh-ins in trailing 7d", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([
              { date: TODAY, weight: 70.0 },
              { date: ymdDaysBefore(1), weight: 70.5 },
              { date: ymdDaysBefore(2), weight: 71.0 },
              { date: ymdDaysBefore(3), weight: 71.5 },
            ]),
          }),
        ),
      );
      expect(r?.weight_7d_avg_kg).toBe(70.8); // (70+70.5+71+71.5)/4 = 70.75 → 70.8 (half-to-even)
    });

    it("omits when <4 weigh-ins in trailing 7d", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([
              { date: TODAY, weight: 70.0 },
              { date: ymdDaysBefore(1), weight: 70.5 },
              { date: ymdDaysBefore(2), weight: 71.0 },
            ]),
          }),
        ),
      );
      expect(r?.weight_7d_avg_kg).toBeUndefined();
    });

    it("excludes entries outside the trailing-7d window", () => {
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness([
              { date: TODAY, weight: 70.0 },
              { date: ymdDaysBefore(1), weight: 70.5 },
              { date: ymdDaysBefore(2), weight: 71.0 },
              // today-7 is outside [today-6, today]
              { date: ymdDaysBefore(7), weight: 71.5 },
            ]),
          }),
        ),
      );
      expect(r?.weight_7d_avg_kg).toBeUndefined();
    });
  });

  describe("weight_28d_slope_kg_per_week", () => {
    it("emits when ≥14 weigh-ins in trailing 28d", () => {
      const rows: { date: string; weight: number }[] = [];
      for (let i = 0; i < 14; i++) {
        rows.push({
          date: ymdDaysBefore(i * 2),
          weight: 70 + i * 0.1, // increases as i increases (older dates)
        });
      }
      const r = computeWeightSignal(input(fixture({ wellness: wellness(rows) })));
      // Newer dates have lower weight → negative slope (weight decreasing over time).
      expect(r?.weight_28d_slope_kg_per_week).toBeLessThan(0);
    });

    it("omits when <14 weigh-ins in trailing 28d", () => {
      const rows: { date: string; weight: number }[] = [];
      for (let i = 0; i < 13; i++) {
        rows.push({ date: ymdDaysBefore(i * 2), weight: 70 + i * 0.1 });
      }
      const r = computeWeightSignal(input(fixture({ wellness: wellness(rows) })));
      expect(r?.weight_28d_slope_kg_per_week).toBeUndefined();
    });

    it("guards against the all-same-day degenerate case (den === 0)", () => {
      // Construct 14 entries all on the same day. den = Σ(x − mean)² = 0
      // because every x is the same. Slope should be omitted.
      // Wellness dedup happens upstream typically, but synthesise distinct
      // ids with the same date prefix to exercise the gate.
      const rows: WellnessDay[] = [];
      for (let i = 0; i < 14; i++) {
        rows.push({
          id: `${TODAY}#${i}`, // .slice(0,10) → all "2026-05-10"
          weight: 70 + i * 0.1,
          restingHR: null,
          hrv: null,
          sleepSecs: null,
          sleepQuality: null,
        } as WellnessDay);
      }
      const r = computeWeightSignal(input(fixture({ wellness: rows })));
      expect(r?.weight_28d_slope_kg_per_week).toBeUndefined();
    });

    it("rounds slope to 3dp via banker's rounding", () => {
      const rows: { date: string; weight: number }[] = [];
      for (let i = 0; i < 14; i++) {
        rows.push({ date: ymdDaysBefore(i * 2), weight: 70 + i * 0.01 });
      }
      const r = computeWeightSignal(
        input(fixture({ wellness: wellness(rows) })),
      );
      expect(r?.weight_28d_slope_kg_per_week).toBeDefined();
      // 3-decimal precision verified by parity fixture; here we just assert
      // it lands at 3dp and not 1dp.
      const s = r!.weight_28d_slope_kg_per_week!;
      const stringified = s.toString();
      // It must be a finite number, three or fewer decimal places.
      expect(Number.isFinite(s)).toBe(true);
      expect(stringified).toMatch(/^-?\d+(\.\d{1,3})?$/);
    });
  });

  describe("populated-branch parity fixture", () => {
    it("emits all four gated groups when the populated fixture's gates fire", () => {
      // Mirror the populated-benchmark-and-consistency fixture's weight signal
      // (gates exercised: latest ≤14d, FTP=tested, wkg_block trio, 7d-avg,
      // 28d-slope). The exact values are pinned by the parity gate; here we
      // just verify the SET of keys present.
      const rows: { date: string; weight: number }[] = [
        { date: "2026-05-10", weight: 72.0 },
        { date: "2026-05-09", weight: 72.1 },
        { date: "2026-05-08", weight: 72.2 },
        { date: "2026-05-07", weight: 72.0 },
        { date: "2026-05-06", weight: 71.9 },
        { date: "2026-05-05", weight: 72.0 },
        { date: "2026-05-04", weight: 72.1 },
        { date: "2026-05-02", weight: 72.3 },
        { date: "2026-04-30", weight: 72.4 },
        { date: "2026-04-28", weight: 72.5 },
        { date: "2026-04-25", weight: 72.6 },
        { date: "2026-04-22", weight: 72.7 },
        { date: "2026-04-19", weight: 72.8 },
        { date: "2026-04-15", weight: 72.9 },
      ];
      const r = computeWeightSignal(
        input(
          fixture({
            wellness: wellness(rows),
            current_ftp_outdoor: 270,
            ftp_history_outdoor: { "2026-04-15": 265 },
          }),
        ),
      );
      expect(r).toEqual({
        weight_latest_kg: 72,
        weight_latest_date: "2026-05-10",
        wkg_current: 3.75,
        wkg_ftp_source: "tested",
        ftp_setting_date: "2026-04-15",
        wkg_block_start: 3.7,
        wkg_block_end: 3.75,
        wkg_block_delta: 0.05,
        weight_7d_avg_kg: 72,
        weight_28d_slope_kg_per_week: -0.279,
      });
    });
  });
});
