import { describe, expect, it, vi } from "vitest";
import type {
  ReferenceBundle,
  VerifiedSnapshotReader,
} from "@enduragent/kernel/reference/local-bundle";
import { buildMetricInput } from "@enduragent/kernel/reference/local-bundle";
import {
  computeHrCurveDelta,
  computePowerCurveDelta,
  computeSustainabilityProfile,
  type SustainabilitySportBlock,
} from "@enduragent/kernel/reference/metrics";
import {
  ANALYTICS_CURVE_PARTS,
  analyticsCurveWindows,
  type AnalyticsCurveState,
} from "@enduragent/kernel/store";
import { AnalyticsCurveProjectionError, projectAnalyticsCurveEvidence } from "../src/index.js";

const FROZEN_ON = "2026-08-07";
const FROZEN_EPOCH_SECONDS = Date.parse(`${FROZEN_ON}T12:00:00.000Z`) / 1_000;
const WINDOWS = analyticsCurveWindows(FROZEN_ON);
const CURRENT = `r.${WINDOWS.current.start}.${WINDOWS.current.end}`;
const PREVIOUS = `r.${WINDOWS.previous.start}.${WINDOWS.previous.end}`;
const SUSTAINABILITY = `r.${WINDOWS.sustainability.start}.${WINDOWS.sustainability.end}`;

function currentState(): NonNullable<AnalyticsCurveState["current"]> {
  return {
    generation: {
      generationId: "a".repeat(64),
      frozenEpochSeconds: FROZEN_EPOCH_SECONDS,
      frozenOn: FROZEN_ON,
      windows: WINDOWS,
    },
    evidence: ANALYTICS_CURVE_PARTS.map((part, index) => {
      const address = (index + 1).toString(16).padStart(64, "0");
      return {
        evidenceId: (index + 10).toString(16).padStart(64, "0"),
        generationId: "a".repeat(64),
        ...part,
        requestIdentity: (index + 20).toString(16).padStart(64, "0"),
        archiveAddress: address,
        archiveRelPath: `2026/08/${address}.json.gz`,
        archiveEpochSeconds: FROZEN_EPOCH_SECONDS,
        decodedBytes: 100,
      };
    }),
    promotedEpochSeconds: FROZEN_EPOCH_SECONDS,
  };
}

function powerCurve(id: string, secs: readonly number[], values: readonly (number | null)[]) {
  return { id, secs: [...secs], values: [...values], provider_private_field: "not-projected" };
}

function heartRateCurve(id: string, secs: readonly number[], values: readonly (number | null)[]) {
  return { id, secs: [...secs], values: [...values], provider_private_field: "not-projected" };
}

function payloads(): readonly unknown[] {
  return [
    {
      activities: { private_activity: { id: "private_activity", start_date_local: FROZEN_ON } },
      list: [
        powerCurve(CURRENT, [5, 60, 300, 1_200, 3_600], [1_000, 500, 350, 280, 240]),
        powerCurve(PREVIOUS, [5, 60, 300, 1_200, 3_600], [900, 480, 330, 260, 230]),
        powerCurve(SUSTAINABILITY, [300, 600, 1_200, 3_600], [360, 330, 285, 245]),
        powerCurve("r.1900-01-01.1900-01-02", [5], [9_999]),
      ],
    },
    {
      activities: {},
      list: [
        powerCurve(CURRENT, [5, 300], [1_100, 340]),
        powerCurve(SUSTAINABILITY, [300, 600, 1_200, 3_600], [370, 320, 275, 235]),
      ],
    },
    {
      activities: {},
      list: [
        heartRateCurve(CURRENT, [60, 300, 1_200, 3_600], [180, 175, 165, 150]),
        heartRateCurve(PREVIOUS, [60, 300, 1_200, 3_600], [175, 170, 160, 148]),
        heartRateCurve(SUSTAINABILITY, [300, 600, 1_200, 3_600], [175, 170, 165, 150]),
      ],
    },
    {
      activities: {},
      list: [
        heartRateCurve(CURRENT, [60, 300], [178, 176]),
        heartRateCurve(SUSTAINABILITY, [300, 600, 1_200, 3_600], [176, 169, 164, 149]),
      ],
    },
  ];
}

function reader(
  values: readonly unknown[],
): VerifiedSnapshotReader & { read: ReturnType<typeof vi.fn> } {
  const byAddress = new Map(
    currentState().evidence.map((evidence, index) => [evidence.archiveAddress, values[index]]),
  );
  const read = vi.fn(async (reference: { address: string }) => byAddress.get(reference.address));
  return { readVerifiedSnapshot: read, read };
}

describe("analytics curve evidence projection", () => {
  it("allowlists archived curves, aggregates Ride/VirtualRide maxima, and feeds existing metrics", async () => {
    const snapshots = reader(payloads());
    const projected = await projectAnalyticsCurveEvidence(currentState(), snapshots);

    expect(snapshots.read).toHaveBeenCalledTimes(4);
    expect(projected.powerCurves.list.map((curve) => curve.id)).toEqual([
      CURRENT,
      PREVIOUS,
      SUSTAINABILITY,
    ]);
    expect(projected.powerCurves.list[0]).toEqual({
      id: CURRENT,
      secs: [5, 60, 300, 1_200, 3_600],
      watts: [1_100, 500, 350, 280, 240],
    });
    expect(projected.hrCurves.list[0]).toEqual({
      id: CURRENT,
      secs: [60, 300, 1_200, 3_600],
      values: [180, 176, 165, 150],
    });
    expect(JSON.stringify(projected)).not.toMatch(/private_activity|provider_private_field|9999/);
    expect(projected.sustainabilityCurves.cycling?.power.VirtualRide?.list[0]?.watts[0]).toBe(370);

    const bundle: ReferenceBundle = {
      activities: [],
      wellness: [],
      ftpHistory: [],
      athlete: { sportSettings: [{ types: ["Ride", "VirtualRide"], ftp: 250, lthr: 170 }] },
      ...projected,
    };
    const input = buildMetricInput(bundle, `${FROZEN_ON}T12:00:00`);
    expect(computePowerCurveDelta(input).anchors?.["5s"]).toEqual({
      current_watts: 1_100,
      previous_watts: 900,
      pct_change: 22.2,
    });
    expect(computeHrCurveDelta(input).anchors?.["300s"]).toEqual({
      current_bpm: 176,
      previous_bpm: 170,
      pct_change: 3.5,
    });
    const cycling = computeSustainabilityProfile(input).cycling as SustainabilitySportBlock;
    expect(cycling.anchors?.["300s"]).toMatchObject({
      actual_watts: 370,
      actual_hr: 176,
      source: "observed_indoor",
    });
    expect(cycling.anchors?.["600s"]).toMatchObject({
      actual_watts: 330,
      actual_hr: 170,
      source: "observed_outdoor",
    });
  });

  it("keeps a valid empty VirtualRide response as explicit empty per-type evidence", async () => {
    const values = payloads().map((value, index) =>
      index === 1 || index === 3 ? { activities: {}, list: [] } : value,
    );
    const projected = await projectAnalyticsCurveEvidence(currentState(), reader(values));

    expect(projected.powerCurves.list).toHaveLength(3);
    expect(projected.sustainabilityCurves.cycling?.power.VirtualRide).toEqual({ list: [] });
    expect(projected.sustainabilityCurves.cycling?.hr.VirtualRide).toEqual({ list: [] });
  });

  it("fails closed with a path-neutral error on malformed axes or unreadable evidence", async () => {
    const malformed = [...payloads()];
    malformed[0] = {
      activities: {},
      list: [powerCurve(CURRENT, [60, 5], [500, 1_000])],
    };
    const first = await projectAnalyticsCurveEvidence(currentState(), reader(malformed)).catch(
      (error: unknown) => error,
    );
    expect(first).toEqual(new AnalyticsCurveProjectionError());
    expect(first).toMatchObject({
      code: "ANALYTICS_CURVE_PROJECTION_FAILED",
      stack: "AnalyticsCurveProjectionError: analytics curve evidence could not be projected",
    });

    const snapshots: VerifiedSnapshotReader = {
      async readVerifiedSnapshot() {
        throw new Error("/private/archive/athlete-secret.json.gz");
      },
    };
    const second = await projectAnalyticsCurveEvidence(currentState(), snapshots).catch(
      (error: unknown) => error,
    );
    expect(JSON.stringify(second)).not.toContain("athlete-secret");
    expect(second).not.toHaveProperty("cause");
  });

  it("rejects duplicate promoted parts before reading any archive payload", async () => {
    const current = currentState();
    const duplicate = {
      ...current,
      evidence: [current.evidence[0]!, current.evidence[0]!, ...current.evidence.slice(2)],
    };
    const snapshots = reader(payloads());
    await expect(projectAnalyticsCurveEvidence(duplicate, snapshots)).rejects.toBeInstanceOf(
      AnalyticsCurveProjectionError,
    );
    expect(snapshots.read).not.toHaveBeenCalled();
  });
});
