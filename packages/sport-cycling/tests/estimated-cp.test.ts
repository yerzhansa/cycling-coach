import { describe, expect, it } from "vitest";
import type { SustainabilityFamilyCurves } from "@enduragent/kernel/reference/schemas";
import { projectCyclingEstimatedCp } from "../src/estimated-cp.js";

function curves(
  overrides: {
    readonly shortPower?: number;
    readonly longPower?: number;
    readonly includeLong?: boolean;
    readonly ignoredShort?: boolean;
    readonly shortDevice?: string | null;
    readonly shortDeviceWatts?: boolean;
    readonly shortMissingTimestamps?: boolean;
    readonly shortMissingPowerSamples?: boolean;
  } = {},
): SustainabilityFamilyCurves {
  const includeLong = overrides.includeLong ?? true;
  return {
    power: {
      Ride: {
        activities: {
          short: {
            id: "short",
            start_date_local: "2026-08-18T06:00:00",
            name: "Tuesday Hill Repeats",
            type: "Ride",
            device_watts: overrides.shortDeviceWatts ?? true,
            icu_ignore_power: overrides.ignoredShort ?? false,
            power_meter:
              overrides.shortDevice === undefined ? "Favero Assioma Duo" : overrides.shortDevice,
            missing_timestamps: overrides.shortMissingTimestamps ?? false,
            missing_power_samples: overrides.shortMissingPowerSamples ?? false,
          },
          long: {
            id: "long",
            start_date_local: "2026-08-09T07:00:00",
            name: "Sunday Tempo Climb",
            type: "Ride",
            device_watts: true,
            icu_ignore_power: false,
            device_name: "Garmin Rally RS200",
          },
        },
        list: [
          {
            id: "r.2026-07-12.2026-08-22",
            secs: includeLong ? [120, 180, 900] : [120, 180],
            watts: includeLong
              ? [
                  overrides.shortPower ?? 390,
                  overrides.shortPower ?? 407,
                  overrides.longPower ?? 311,
                ]
              : [overrides.shortPower ?? 390, overrides.shortPower ?? 407],
            activity_ids: includeLong ? ["short", "short", "long"] : ["short", "short"],
            start_indexes: includeLong ? [100, 200, 300] : [100, 200],
          },
        ],
      },
      VirtualRide: { list: [], activities: {} },
    },
    hr: {},
  };
}

function tieCurves(options: {
  readonly competingStartedAt: string;
  readonly competingDurationS: 180 | 190;
}): SustainabilityFamilyCurves {
  return {
    power: {
      Ride: {
        activities: {
          older: {
            id: "older",
            start_date_local: "2026-08-17T06:00:00",
            name: "Older effort",
            device_watts: true,
            power_meter: "Meter A",
          },
          "newer-b": {
            id: "newer-b",
            start_date_local: options.competingStartedAt,
            name: "Newer B",
            device_watts: true,
            power_meter: "Meter B",
          },
          long: {
            id: "long",
            start_date_local: "2026-08-16T06:00:00",
            name: "Long effort",
            device_watts: true,
            power_meter: "Meter L",
          },
        },
        list: [
          {
            id: "ride-window",
            secs: [160, options.competingDurationS, 900],
            watts: [407, 407, 311],
            activity_ids: ["older", "newer-b", "long"],
            start_indexes: [1, 2, 3],
          },
        ],
      },
      VirtualRide: {
        activities: {
          "newer-a": {
            id: "newer-a",
            start_date_local: "2026-08-18T06:00:00",
            name: "Newer A",
            device_watts: true,
            device_name: "Meter C",
          },
        },
        list: [
          {
            id: "virtual-window",
            secs: [180],
            watts: [407],
            activity_ids: ["newer-a"],
            start_indexes: [4],
          },
        ],
      },
    },
    hr: {},
  };
}

describe("cycling Estimated CP projection", () => {
  it("selects one eligible effort in each band and rounds only the visible value", () => {
    expect(
      projectCyclingEstimatedCp({
        curves: curves(),
        calculatedOn: "2026-08-22",
        lastSuccessfulSyncAtMs: 1_777_000_000_000,
        stale: false,
      }),
    ).toEqual({
      status: "available",
      watts: 287,
      calculatedOn: "2026-08-22",
      lastSuccessfulSyncAtMs: 1_777_000_000_000,
      unavailableReason: null,
      efforts: [
        {
          activityId: "short",
          ride: "Tuesday Hill Repeats",
          date: "2026-08-18",
          durationS: 180,
          averagePowerW: 407,
          device: "Favero Assioma Duo",
        },
        {
          activityId: "long",
          ride: "Sunday Tempo Climb",
          date: "2026-08-09",
          durationS: 900,
          averagePowerW: 311,
          device: "Garmin Rally RS200",
        },
      ],
    });
  });

  it("keeps the last valid projection visible as stale", () => {
    expect(
      projectCyclingEstimatedCp({
        curves: curves(),
        calculatedOn: "2026-08-22",
        lastSuccessfulSyncAtMs: 1_777_000_000_000,
        stale: true,
      }).status,
    ).toBe("stale");
  });

  it("rounds a mathematically valid sub-watt result without adding a physiological minimum", () => {
    expect(
      projectCyclingEstimatedCp({
        curves: curves({ shortPower: 200, longPower: 36_072 / 900 }),
        calculatedOn: "2026-08-22",
        lastSuccessfulSyncAtMs: null,
        stale: false,
      }),
    ).toMatchObject({ status: "available", watts: 0 });
  });

  it("breaks equal-power ties by newer ride, longer duration, then stable activity id", () => {
    const selected = (value: SustainabilityFamilyCurves): string | undefined => {
      const result = projectCyclingEstimatedCp({
        curves: value,
        calculatedOn: "2026-08-22",
        lastSuccessfulSyncAtMs: null,
        stale: false,
      });
      expect(result.status).toBe("available");
      return result.efforts[0]?.activityId;
    };

    expect(
      selected(tieCurves({ competingStartedAt: "2026-08-18T05:00:00", competingDurationS: 190 })),
    ).toBe("newer-a");
    expect(
      selected(tieCurves({ competingStartedAt: "2026-08-18T06:00:00", competingDurationS: 190 })),
    ).toBe("newer-b");
    expect(
      selected(tieCurves({ competingStartedAt: "2026-08-18T06:00:00", competingDurationS: 180 })),
    ).toBe("newer-a");
  });

  it("allows both duration bands to use the same measured ride", () => {
    const sameRide = curves();
    const ride = sameRide.power.Ride;
    if (ride === undefined) throw new TypeError("Ride evidence missing.");
    ride.list[0]!.activity_ids = ["short", "short", "short"];

    const result = projectCyclingEstimatedCp({
      curves: sameRide,
      calculatedOn: "2026-08-22",
      lastSuccessfulSyncAtMs: null,
      stale: false,
    });

    expect(result.status).toBe("available");
    expect(result.efforts.map((effort) => effort.activityId)).toEqual(["short", "short"]);
  });

  it("hides missing, unmeasured, ignored, incomplete, and mathematically invalid evidence", () => {
    expect(
      projectCyclingEstimatedCp({
        curves: curves({ includeLong: false }),
        calculatedOn: "2026-08-22",
        lastSuccessfulSyncAtMs: null,
        stale: false,
      }),
    ).toMatchObject({ status: "unavailable", unavailableReason: "missing-effort" });
    expect(
      projectCyclingEstimatedCp({
        curves: curves({ ignoredShort: true }),
        calculatedOn: "2026-08-22",
        lastSuccessfulSyncAtMs: null,
        stale: false,
      }),
    ).toMatchObject({ status: "unavailable", unavailableReason: "missing-effort" });
    for (const hidden of [
      curves({ shortDeviceWatts: false }),
      curves({ shortDevice: null }),
      curves({ shortMissingTimestamps: true }),
      curves({ shortMissingPowerSamples: true }),
    ]) {
      expect(
        projectCyclingEstimatedCp({
          curves: hidden,
          calculatedOn: "2026-08-22",
          lastSuccessfulSyncAtMs: null,
          stale: false,
        }),
      ).toMatchObject({ status: "unavailable", unavailableReason: "missing-effort" });
    }
    expect(
      projectCyclingEstimatedCp({
        curves: curves({ shortPower: 300, longPower: 311 }),
        calculatedOn: "2026-08-22",
        lastSuccessfulSyncAtMs: null,
        stale: false,
      }),
    ).toMatchObject({ status: "unavailable", unavailableReason: "mathematically-invalid" });
  });
});
