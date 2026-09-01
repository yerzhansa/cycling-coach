import type {
  CoachOperationProgressNotificationEnvelope,
  CyclingTrainingContext,
  ImportFilesRpcResult,
  PowerProgressComputed,
} from "@enduragent/coach-contract";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RideImportState } from "../src/ride-import";
import { EMPTY_RIDE_ANALYSIS } from "../src/activity-analysis/controller";
import { restoreManualSyncFocus } from "../src/state/manual-sync-focus";
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { IDLE_RIDE_IMPORT } from "../src/state/ride-import-slice";
import { useEnduragentStore } from "../src/state/store";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice";
import { IDLE_TRAINING_EXPORT } from "../src/training-export/controller";
import type { TrainingContextViewState } from "../src/training-context/controller";
import { toManualSyncViewState } from "../src/training-context/manual-sync";
import { TrainingView } from "../src/ui/training/TrainingView";

function planItem(index: number) {
  return {
    id: `plan-${index}`,
    date: `1998-07-${String(10 + index).padStart(2, "0")}`,
    name: `Endurance ride ${index}`,
    category: "WORKOUT" as const,
    workoutType: "Ride",
  };
}

const computedPowerProgress = {
  kind: "computed",
  currentWindow: { start: "1998-06-22", end: "1998-07-19" },
  previousWindow: { start: "1998-05-25", end: "1998-06-21" },
  anchors: [
    {
      durationSeconds: 5,
      current: { kind: "computed", watts: 1_120 },
      previous: { kind: "computed", watts: 1_050 },
      change: { kind: "computed", percent: 6.7 },
    },
    {
      durationSeconds: 60,
      current: { kind: "computed", watts: 620 },
      previous: { kind: "computed", watts: 600 },
      change: { kind: "computed", percent: 3.3 },
    },
    {
      durationSeconds: 300,
      current: { kind: "computed", watts: 390 },
      previous: { kind: "computed", watts: 400 },
      change: { kind: "computed", percent: -2.5 },
    },
    {
      durationSeconds: 1_200,
      current: { kind: "computed", watts: 310 },
      previous: { kind: "computed", watts: 310 },
      change: { kind: "computed", percent: 0 },
    },
    {
      durationSeconds: 3_600,
      current: { kind: "unavailable" },
      previous: { kind: "unavailable" },
      change: { kind: "unavailable" },
    },
  ],
  rotation: "sprint",
  heartRateContext: {
    kind: "computed",
    anchors: [
      {
        durationSeconds: 60,
        current: { kind: "computed", bpm: 181 },
        previous: { kind: "computed", bpm: 178 },
        change: { kind: "computed", percent: 1.7 },
      },
      {
        durationSeconds: 300,
        current: { kind: "computed", bpm: 176 },
        previous: { kind: "computed", bpm: 175 },
        change: { kind: "computed", percent: 0.6 },
      },
      {
        durationSeconds: 1_200,
        current: { kind: "computed", bpm: 165 },
        previous: { kind: "computed", bpm: 166 },
        change: { kind: "computed", percent: -0.6 },
      },
      {
        durationSeconds: 3_600,
        current: { kind: "computed", bpm: 151 },
        previous: { kind: "computed", bpm: 150 },
        change: { kind: "computed", percent: 0.7 },
      },
    ],
  },
  sustainabilityContext: {
    kind: "computed",
    window: { start: "1998-06-08", end: "1998-07-19" },
    coverageRatio: 0.83,
    sourceContext: "mixed",
  },
  freshness: "fresh",
  asOf: "1998-07-19T08:00:00.000Z",
} as const satisfies PowerProgressComputed;

const context: CyclingTrainingContext = {
  performanceProgress: computedPowerProgress,
  recentRides: {
    kind: "computed",
    asOf: "1998-07-19T08:00:00.000Z",
    windowDays: 28,
    items: [
      {
        id: "a".repeat(64),
        subSport: "road",
        startEpochSeconds: 900_000_000,
        timezoneOffsetSeconds: 21_600,
        localDate: "1998-07-09",
        elapsedSeconds: 5_460,
        movingSeconds: 5_100,
        distanceMeters: 42_120,
      },
      {
        id: "b".repeat(64),
        subSport: "indoor_cycling",
        startEpochSeconds: 899_900_000,
        timezoneOffsetSeconds: null,
        localDate: "1998-07-08",
        elapsedSeconds: null,
        movingSeconds: 3_600,
        distanceMeters: null,
      },
    ],
  },
  trainingHistory: { kind: "unavailable", reason: "not-synced" },
  anchorZones: {
    kind: "computed",
    asOf: "1998-07-19T08:00:00.000Z",
    anchor: {
      watts: 268,
      validFrom: "1998-07-01",
      source: "intervals.icu",
      confidence: "platform",
      ageDays: 18.4,
      stalenessBand: "aging",
      stale: true,
    },
    zones: [
      { name: "Recovery", range: "0–147 W", overlaps: false },
      { name: "Endurance", range: "148–201 W", overlaps: true },
    ],
  },
  cyclingLoad: {
    kind: "computed",
    asOf: "1998-07-19T08:00:00.000Z",
    source: "intervals.icu",
    windowDays: 7,
    value: 412,
    activityCount: 5,
    missingLoadCount: 2,
  },
  plan: {
    kind: "computed",
    asOf: "1998-07-19T08:00:00.000Z",
    items: Array.from({ length: 9 }, (_, index) => planItem(index + 1)),
  },
  adherence: {
    kind: "computed",
    asOf: "1998-07-19T08:00:00.000Z",
    ratio: 0.8,
    plannedDays: 5,
    completedDays: 4,
    matchedDays: 4,
  },
  wellnessTrend: {
    kind: "computed",
    asOf: "1998-07-19T08:00:00.000Z",
    windowDays: 7,
    series: [
      {
        metric: "hrv",
        unit: "ms",
        points: [
          { date: "1998-07-18", value: 60 },
          { date: "1998-07-19", value: 70 },
        ],
      },
      { metric: "sleep", unit: "seconds", points: [{ date: "1998-07-19", value: 27_000 }] },
      { metric: "resting-hr", unit: "bpm", points: [] },
    ],
  },
};

const unknownContext: CyclingTrainingContext = {
  performanceProgress: { kind: "unavailable", reason: "not-synced" },
  recentRides: { kind: "unknown", reason: "not-synced" },
  trainingHistory: { kind: "unavailable", reason: "not-synced" },
  anchorZones: { kind: "unknown", reason: "missing-anchor" },
  cyclingLoad: { kind: "unknown", reason: "no-platform-load" },
  plan: { kind: "unknown", reason: "no-plan" },
  adherence: { kind: "unknown", reason: "insufficient-data" },
  wellnessTrend: { kind: "unknown", reason: "no-wellness" },
};

function ready(overrides: Partial<TrainingContextViewState> = {}): TrainingContextViewState {
  return {
    status: "ready",
    metadata: {
      lastUpdated: "1998-07-19T08:00:00.000Z",
      lastSynced: "1998-07-19T07:55:00.000Z",
      freshness: "fresh",
      degraded: false,
    },
    trainingContext: context,
    unitsPreference: { status: "ready", value: "metric", source: "default" },
    ...overrides,
  };
}

function importResult(imported: number, quarantined: number): ImportFilesRpcResult {
  return {
    schemaVersion: 2,
    files: { total: imported + quarantined, imported, quarantined },
    changes: {
      rawFilesInserted: imported,
      sourceRecordsInserted: imported,
      sourceRecordsUpdated: 0,
      relinkedSourceRecords: 0,
    },
    publication: { scope: "activities-and-streams", status: "available" },
  };
}

function progressEnvelope(completed: number): CoachOperationProgressNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "coach.operationProgress",
    params: {
      requestId: 3,
      requestMethod: "importFiles",
      event: { phase: completed === 0 ? "started" : "completed", completed, total: 4 },
    },
  };
}

function update(patch: Partial<Parameters<typeof useEnduragentStore.setState>[0]>): void {
  act(() => {
    useEnduragentStore.setState(patch);
  });
}

function setRideImport(state: RideImportState): void {
  update({ rideImport: state });
}

beforeEach(() => {
  useEnduragentStore.setState({
    activeView: "training",
    training: ready(),
    selectedRide: null,
    rideAnalysis: EMPTY_RIDE_ANALYSIS,
    rideAnalysisActions: null,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    rideImport: IDLE_RIDE_IMPORT,
    rideImportSuppressed: false,
    rideImportActions: null,
    trainingExport: IDLE_TRAINING_EXPORT,
    trainingExportActions: null,
  });
});

afterEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    training: EMPTY_TRAINING_SURFACE,
    selectedRide: null,
    rideAnalysis: EMPTY_RIDE_ANALYSIS,
    rideAnalysisActions: null,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    rideImport: IDLE_RIDE_IMPORT,
    rideImportSuppressed: false,
    rideImportActions: null,
    trainingExport: IDLE_TRAINING_EXPORT,
    trainingExportActions: null,
  });
});

describe("training page", () => {
  it("renders every panel in the pinned order with the training data as of its own timestamps", () => {
    render(<TrainingView />);

    expect(screen.getByRole("region", { name: "Training" })).toBeInTheDocument();
    const headings = [...document.querySelectorAll("[data-panel] h2")];
    expect(headings.map((node) => node.textContent)).toEqual([
      "Sync",
      "Power progress",
      "Recent rides",
      "Current cycling anchor",
      "Cycling Load",
      "Plan",
      "Adherence",
      "Wellness trend",
      "Import ride files",
    ]);
    expect(screen.getByText("268 W")).toBeInTheDocument();
    expect(screen.getByText("Aging · 18d")).toBeInTheDocument();
    expect(screen.getByText("As of 1998-07-19 · intervals.icu · platform")).toBeInTheDocument();
    expect(screen.getByText("412")).toBeInTheDocument();
    expect(screen.getByText("5 cycling activities")).toBeInTheDocument();
    expect(screen.getByText("2 cycling activities have no platform Load")).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("4/5 planned days matched")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Add FIT, TCX or GPX files from this Mac. You can also drop them onto the window.",
      ),
    ).toBeInTheDocument();
    expect(document.querySelector(".training-status")).toHaveProperty("hidden", true);
  });

  it("opens a local ride review and restores focus without exposing its canonical identifier", async () => {
    const user = userEvent.setup();
    render(<TrainingView />);

    const recent = screen.getByRole("region", { name: "Recent rides" });
    const opener = within(recent).getByRole("button", {
      name: "Review road ride from 1998-07-09 · 22:00, 1h 31m, 42.1 km",
    });
    await user.click(opener);

    expect(screen.getByRole("region", { name: "Ride review" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Ride review" })).toHaveFocus();
    expect(screen.getByRole("heading", { level: 2, name: "Road ride" })).toBeInTheDocument();
    expect(screen.getByText("1h 31m")).toBeInTheDocument();
    expect(screen.getByText("42.1 km")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("a".repeat(64));

    await user.click(screen.getByRole("button", { name: "Back to training" }));
    expect(screen.getByRole("region", { name: "Training" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Review road ride from 1998-07-09 · 22:00, 1h 31m, 42.1 km",
      }),
    ).toHaveFocus();
  });

  it("offers FIT and GPX and exports a ride without rendering its canonical ID", async () => {
    const user = userEvent.setup();
    const exportActivity = vi.fn(async () => {});
    const exportWorkoutArchive = vi.fn(async () => {});
    useEnduragentStore.setState({
      trainingExportActions: { exportActivity, exportWorkoutArchive },
    });
    render(<TrainingView />);
    await user.click(
      screen.getByRole("button", {
        name: "Review road ride from 1998-07-09 · 22:00, 1h 31m, 42.1 km",
      }),
    );

    const panel = screen.getByRole("region", { name: "Export ride" });
    await user.click(within(panel).getByRole("combobox", { name: "File format" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "FIT",
      "GPX",
    ]);
    await user.click(screen.getByRole("option", { name: "GPX" }));
    await user.click(within(panel).getByRole("button", { name: "Export ride" }));
    expect(exportActivity).toHaveBeenCalledWith({
      canonicalActivityId: "a".repeat(64),
      localDate: "1998-07-09",
      format: "gpx",
    });
    expect(document.body).not.toHaveTextContent("a".repeat(64));

    act(() => {
      useEnduragentStore.setState({
        trainingExport: { status: "saved", target: "activity", byteLength: 4_096 },
      });
    });
    expect(within(panel).getByRole("status")).toHaveTextContent("Export saved locally.");
  });

  it("uses the cycling unit preference and explicit unavailable ride metadata", () => {
    useEnduragentStore.setState({
      training: ready({
        unitsPreference: { status: "ready", value: "imperial", source: "cycling" },
      }),
    });
    render(<TrainingView />);

    const recent = screen.getByRole("region", { name: "Recent rides" });
    expect(within(recent).getByText("26.2 mi")).toBeInTheDocument();
    expect(within(recent).getByText("Distance unavailable")).toBeInTheDocument();
    expect(within(recent).getByText("1h 0m")).toBeInTheDocument();
  });

  it("shows a neutral, time-weighted local aerobic drift estimate with its limitations", async () => {
    const user = userEvent.setup();
    if (context.recentRides.kind !== "computed") throw new Error("expected fixture rides");
    const ride = context.recentRides.items[0]!;
    useEnduragentStore.setState({
      rideAnalysis: {
        activityId: ride.id,
        status: "refresh-unavailable",
        revision: "c".repeat(64),
        loadingSections: [],
        failedSections: ["aerobic-drift"],
        sections: {
          aerobicDrift: {
            kind: "computed",
            data: {
              method: "local-time-weighted-efficiency-factor",
              firstHalf: {
                durationSeconds: 1_650,
                sampleCount: 1_650,
                averagePowerWatts: 205,
                averageHeartRateBpm: 140,
                efficiencyFactor: 1.46,
              },
              secondHalf: {
                durationSeconds: 1_650,
                sampleCount: 1_650,
                averagePowerWatts: 202,
                averageHeartRateBpm: 145,
                efficiencyFactor: 1.39,
              },
              decouplingPercent: 4.8,
              coverage: {
                totalSamples: 3_600,
                validSamples: 3_300,
                includedDurationSeconds: 3_300,
                windowDurationSeconds: 3_600,
                fraction: 3_300 / 3_600,
              },
              evidence: "limited",
              limitations: ["duration-under-60-minutes", "moving-status-unavailable"],
            },
            provenance: {
              source: "local-canonical",
              delivery: "live",
              observedAt: "1998-07-19T08:00:00.000Z",
            },
          },
        },
      },
    });
    render(<TrainingView />);

    await user.click(
      screen.getByRole("button", {
        name: "Review road ride from 1998-07-09 · 22:00, 1h 31m, 42.1 km",
      }),
    );

    const panel = screen.getByRole("region", { name: "Local aerobic drift estimate" });
    expect(within(panel).getByText("+4.8%")).toHaveAccessibleName(
      "Observed efficiency-factor change +4.8%",
    );
    expect(within(panel).getByText("1.46 EF")).toBeInTheDocument();
    expect(within(panel).getByText("1.39 EF")).toBeInTheDocument();
    expect(within(panel).getByText(/92% usable time/)).toBeInTheDocument();
    expect(within(panel).getByText("Limited context")).toBeInTheDocument();
    expect(
      within(panel).getByText(
        "No moving-status stream was available, so stopped time may be included.",
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByText("Showing the previous result. The latest refresh did not finish."),
    ).toBeInTheDocument();
    expect(panel).not.toHaveTextContent("good");
    expect(panel).not.toHaveTextContent("bad");
    expect(document.body).not.toHaveTextContent(ride.id);
  });

  it("shows ordered intervals and explicitly scoped five-minute best efforts", async () => {
    const user = userEvent.setup();
    if (context.recentRides.kind !== "computed") throw new Error("expected fixture rides");
    const ride = context.recentRides.items[0]!;
    const emptyMetrics = {
      movingSeconds: null,
      elapsedSeconds: null,
      distanceMeters: null,
      averagePowerWatts: null,
      maximumPowerWatts: null,
      averageHeartRateBpm: null,
      maximumHeartRateBpm: null,
      averageCadenceRpm: null,
      maximumCadenceRpm: null,
      zone: null,
      intensityPercent: null,
      trainingLoad: null,
    } as const;
    const provenance = {
      source: "provider" as const,
      delivery: "live" as const,
      observedAt: "1998-07-19T08:00:00.000Z",
    };
    useEnduragentStore.setState({
      rideAnalysis: {
        activityId: ride.id,
        status: "ready",
        revision: "c".repeat(64),
        loadingSections: [],
        failedSections: [],
        sections: {
          intervals: {
            kind: "computed",
            data: {
              source: "provider",
              intervals: [
                {
                  ...emptyMetrics,
                  ordinal: 1,
                  groupOrdinal: null,
                  kind: "work",
                  label: "Threshold",
                  startIndex: 0,
                  endIndex: 299,
                  startSeconds: 0,
                  endSeconds: 300,
                  movingSeconds: 300,
                  elapsedSeconds: 300,
                  distanceMeters: 2_500,
                  averagePowerWatts: 250,
                  maximumPowerWatts: 310,
                  averageHeartRateBpm: 155,
                  maximumHeartRateBpm: 170,
                },
                {
                  ...emptyMetrics,
                  ordinal: 2,
                  groupOrdinal: null,
                  kind: "recovery",
                  label: null,
                  startIndex: 300,
                  endIndex: 419,
                  startSeconds: 300,
                  endSeconds: 420,
                  movingSeconds: 120,
                  elapsedSeconds: 120,
                },
              ],
              groups: [],
            },
            provenance,
          },
          bestEfforts: {
            kind: "computed",
            data: {
              scope: {
                kind: "selected-activity",
                stream: "power",
                durationSeconds: 300,
                tieRule: "earliest-start",
              },
              efforts: [
                {
                  rank: 1,
                  startIndex: 900,
                  endIndex: 1_199,
                  durationSeconds: 300,
                  distanceMeters: 2_600,
                  averageWatts: 310,
                },
                {
                  rank: 2,
                  startIndex: 300,
                  endIndex: 599,
                  durationSeconds: 300,
                  distanceMeters: null,
                  averageWatts: 300,
                },
              ],
            },
            provenance,
          },
        },
      },
    });
    render(<TrainingView />);

    await user.click(
      screen.getByRole("button", {
        name: "Review road ride from 1998-07-09 · 22:00, 1h 31m, 42.1 km",
      }),
    );

    const intervals = screen.getByRole("region", { name: "Intervals and laps" });
    expect(within(intervals).getByText("Threshold")).toBeInTheDocument();
    expect(within(intervals).getByText("Recovery")).toBeInTheDocument();
    expect(within(intervals).getByText("250 avg · 310 max W")).toBeInTheDocument();
    expect(within(intervals).getAllByLabelText("Unavailable").length).toBeGreaterThan(0);
    expect(intervals).toHaveTextContent("no planned workout targets are inferred");

    const efforts = screen.getByRole("region", { name: "Five-minute best efforts" });
    expect(within(efforts).getByText("#1")).toBeInTheDocument();
    expect(within(efforts).getByText("310 W")).toBeInTheDocument();
    expect(within(efforts).getByText(/This ride · power · 5 min/)).toBeInTheDocument();
    expect(efforts).toHaveTextContent("does not compare against other rides");
    expect(efforts).not.toHaveTextContent(/\bPR\b/);
    expect(document.body).not.toHaveTextContent(ride.id);
  });

  it("shows independent accessible distributions and a distinct server power/HR response", async () => {
    const user = userEvent.setup();
    if (context.recentRides.kind !== "computed") throw new Error("expected fixture rides");
    const ride = context.recentRides.items[0]!;
    const provenance = {
      source: "provider" as const,
      delivery: "live" as const,
      observedAt: "1998-07-19T08:00:00.000Z",
    };
    useEnduragentStore.setState({
      rideAnalysis: {
        activityId: ride.id,
        status: "ready",
        revision: "c".repeat(64),
        loadingSections: [],
        failedSections: [],
        sections: {
          powerDistribution: {
            kind: "computed",
            data: {
              unit: "watts",
              buckets: [
                { lower: 0, upper: 100, seconds: 300 },
                { lower: 100, upper: 200, seconds: 600 },
                { lower: 225, upper: 300, seconds: 120 },
              ],
              totalSeconds: 1_020,
            },
            provenance,
          },
          heartRateDistribution: {
            kind: "computed",
            data: {
              unit: "bpm",
              buckets: [
                { lower: 110, upper: 130, seconds: 420 },
                { lower: 130, upper: 150, seconds: 600 },
              ],
              totalSeconds: 1_020,
            },
            provenance,
          },
          powerHeartRate: {
            kind: "computed",
            data: {
              source: "provider",
              rows: Array.from({ length: 6 }, (_, index) => ({
                startSeconds: index * 60,
                watts: 150 + index * 10,
                heartRateBpm: 120 + index * 2,
                cadenceRpm: index === 0 ? null : 85 + index,
                movingSeconds: 60,
                seconds: 60,
              })),
              curves: [{ kind: "all", coefficients: [100, 0.1], rSquared: 0.9 }],
              coverageFraction: 0.6,
              heartRateLagSeconds: 15,
              warmupSeconds: 60,
              cooldownSeconds: 30,
            },
            provenance,
          },
        },
      },
    });
    render(<TrainingView />);

    await user.click(
      screen.getByRole("button", {
        name: "Review road ride from 1998-07-09 · 22:00, 1h 31m, 42.1 km",
      }),
    );

    const power = screen.getByRole("region", { name: "Power distribution" });
    expect(power).toHaveTextContent("17 min of measured ride time · 3 recorded buckets");
    expect(power).toHaveTextContent("Gaps are left as recorded");
    await user.click(within(power).getByText("Read power distribution as a table"));
    const powerTable = within(power).getByRole("table", {
      name: "Power distribution measured ride time by recorded range",
    });
    expect(within(powerTable).getByText("0 W–100 W")).toBeInTheDocument();
    expect(within(powerTable).getAllByRole("row")).toHaveLength(4);

    const heartRate = screen.getByRole("region", { name: "Heart-rate distribution" });
    expect(heartRate).toHaveTextContent("can load even when power data is unavailable");
    await user.click(within(heartRate).getByText("Read heart-rate distribution as a table"));
    const heartRateTable = within(heartRate).getByRole("table", {
      name: "Heart-rate distribution measured ride time by recorded range",
    });
    expect(within(heartRateTable).getByText("110 bpm–130 bpm")).toBeInTheDocument();

    const response = screen.getByRole("region", { name: "Power and heart-rate response" });
    expect(response).toHaveTextContent("server-cleaned ride segment");
    expect(response).toHaveTextContent("No missing points or lines are interpolated");
    expect(response).toHaveTextContent("60%");
    expect(response).toHaveTextContent("Limited coverage");
    expect(response).toHaveTextContent("separate from the local aerobic drift estimate");
    const fittedCurves = within(response).getByRole("list", { name: "Provider fitted curves" });
    expect(fittedCurves).toHaveTextContent("All retained segments");
    expect(fittedCurves).toHaveTextContent("R² 0.90");
    expect(fittedCurves.querySelector('[data-curve-kind="all"]')).not.toBeNull();
    await user.click(within(response).getByText("Read provider fit details"));
    const fitTable = within(response).getByRole("table", {
      name: "Provider-fitted power and heart-rate curve details",
    });
    expect(fitTable).toHaveTextContent("Model terms in provider order");
    expect(fitTable).toHaveTextContent("100, 0.1");
    await user.click(within(response).getByText("Read all power and heart-rate points as a table"));
    expect(
      within(response).getByRole("table", { name: "Retained power and heart-rate ride segments" }),
    ).toHaveTextContent("150 W");
    expect(document.body).not.toHaveTextContent("provider-");
    expect(document.body).not.toHaveTextContent(ride.id);
  });

  it("explains deterministic unavailable states without offering a pointless retry", async () => {
    const user = userEvent.setup();
    if (context.recentRides.kind !== "computed") throw new Error("expected fixture rides");
    const ride = context.recentRides.items[0]!;
    useEnduragentStore.setState({
      rideAnalysis: {
        activityId: ride.id,
        status: "ready",
        revision: "c".repeat(64),
        loadingSections: [],
        failedSections: [],
        sections: { aerobicDrift: { kind: "unavailable", reason: "activity-too-short" } },
      },
      rideAnalysisActions: { refresh: vi.fn() },
    });
    render(<TrainingView />);
    await user.click(
      screen.getByRole("button", {
        name: "Review road ride from 1998-07-09 · 22:00, 1h 31m, 42.1 km",
      }),
    );

    const panel = screen.getByRole("region", { name: "Local aerobic drift estimate" });
    expect(
      within(panel).getByText(
        "At least 30 usable minutes, with 15 minutes in each half, are required.",
      ),
    ).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("preserves a selected ride across temporary refresh failure and reconciles authoritative lists", () => {
    const store = useEnduragentStore.getState();
    if (context.recentRides.kind !== "computed") throw new Error("expected fixture rides");
    store.openRide(context.recentRides.items[0]!);
    store.setTraining(
      ready({
        trainingContext: {
          ...context,
          recentRides: { kind: "unknown", reason: "temporary-failure" },
        },
      }),
    );
    expect(useEnduragentStore.getState().selectedRide?.id).toBe(context.recentRides.items[0]?.id);

    store.setTraining(
      ready({
        trainingContext: {
          ...context,
          recentRides: { kind: "unknown", reason: "not-synced" },
        },
      }),
    );
    expect(useEnduragentStore.getState().selectedRide).toBeNull();

    store.openRide(context.recentRides.items[0]!);

    store.setTraining(
      ready({
        trainingContext: {
          ...context,
          recentRides: {
            ...context.recentRides,
            items: [{ ...context.recentRides.items[0]!, distanceMeters: 43_000 }],
          },
        },
      }),
    );
    expect(useEnduragentStore.getState().selectedRide?.distanceMeters).toBe(43_000);

    store.setTraining(
      ready({
        trainingContext: {
          ...context,
          recentRides: { ...context.recentRides, items: [context.recentRides.items[1]!] },
        },
      }),
    );
    expect(useEnduragentStore.getState().selectedRide).toBeNull();
  });

  it("renders an accessible five-effort Power Progress comparison with secondary context", async () => {
    const user = userEvent.setup();
    render(<TrainingView />);

    const progress = screen.getByRole("region", { name: "Power progress" });
    expect(
      within(progress).getByText("Short efforts changed more favorably than long efforts."),
    ).toBeInTheDocument();
    expect(
      within(progress).getByText("1998-06-22–1998-07-19 · compared with the prior 28 days"),
    ).toBeInTheDocument();
    expect(within(progress).getByText("Fresh")).toBeInTheDocument();
    const powerTable = within(progress).getByRole("table", {
      name: "Power curve for the current 28 days compared with the previous 28 days",
    });
    expect(within(powerTable).getAllByRole("row")).toHaveLength(6);
    expect(within(powerTable).getByText("1120 W")).toBeInTheDocument();
    expect(within(powerTable).getByLabelText("Increased, 6.7%")).toHaveTextContent("↑ +6.7%");
    expect(within(powerTable).getByLabelText("Decreased, 2.5%")).toHaveTextContent("↓ -2.5%");
    expect(within(powerTable).getAllByLabelText("Unavailable")).toHaveLength(3);
    await user.click(within(progress).getByText("Heart-rate response · 4 efforts"));
    expect(
      within(progress).getByRole("table", {
        name: "Heart-rate curve for the current 28 days compared with the previous 28 days",
      }),
    ).toBeVisible();
    expect(within(progress).getByText("181 bpm")).toBeInTheDocument();
    expect(
      within(progress).getByText(
        "42-day durability context · 83% curve coverage · indoor and outdoor rides",
      ),
    ).toBeInTheDocument();
  });

  it("explains unavailable data and clearly labels a stale last-good comparison", () => {
    useEnduragentStore.setState({
      training: ready({
        trainingContext: {
          ...context,
          performanceProgress: { kind: "unavailable", reason: "invalid-data" },
        },
      }),
    });
    render(<TrainingView />);
    expect(
      screen.getByText("Power progress data could not be verified. Sync again."),
    ).toBeInTheDocument();

    update({
      training: ready({
        trainingContext: {
          ...context,
          performanceProgress: {
            kind: "stale",
            lastGood: { ...computedPowerProgress, freshness: "stale" },
            refreshFailure: { code: "timeout", failedAt: "1998-07-20T08:00:00.000Z" },
          },
        },
      }),
    });
    const progress = screen.getByRole("region", { name: "Power progress" });
    expect(within(progress).getByText(/latest refresh timed out/i)).toHaveTextContent(
      "The latest refresh timed out. Showing the last complete comparison. Failed 1998-07-20 08:00:00 UTC.",
    );
    expect(within(progress).getByText("Stale")).toBeInTheDocument();
    expect(within(progress).getByText("1120 W")).toBeInTheDocument();
  });

  it("renders the power zones and caps the plan at seven upcoming workouts", () => {
    render(<TrainingView />);

    const zones = within(screen.getByRole("region", { name: "Current cycling anchor" }));
    expect(zones.getByText("Recovery")).toBeInTheDocument();
    expect(zones.getByText("148–201 W")).toBeInTheDocument();
    expect(zones.getByText("Endurance")).toHaveAttribute("data-overlaps", "true");

    const plan = within(screen.getByRole("region", { name: "Plan" }));
    expect(plan.getAllByRole("listitem")).toHaveLength(7);
    expect(plan.getByText("Endurance ride 1")).toBeInTheDocument();
    expect(plan.queryByText("Endurance ride 8")).toBeNull();
  });

  it("offers every workout format and exports exactly the visible planned-workout date range", async () => {
    const user = userEvent.setup();
    const exportWorkoutArchive = vi.fn(async () => {});
    useEnduragentStore.setState({
      trainingExportActions: { exportActivity: vi.fn(async () => {}), exportWorkoutArchive },
    });
    render(<TrainingView />);

    const plan = screen.getByRole("region", { name: "Plan" });
    await user.click(within(plan).getByRole("combobox", { name: "Workout format" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "ZWO",
      "MRC",
      "ERG",
      "FIT",
    ]);
    await user.click(screen.getByRole("option", { name: "FIT" }));
    await user.click(within(plan).getByRole("button", { name: "Export workouts" }));
    expect(exportWorkoutArchive).toHaveBeenCalledWith({
      oldest: "1998-07-11",
      newest: "1998-07-17",
      format: "fit",
    });
  });

  it("draws a sparkline per wellness series from the athlete-state readings", () => {
    render(<TrainingView />);

    const wellness = screen.getByRole("region", { name: "Wellness trend" });
    const lines = [...wellness.querySelectorAll("svg polyline")];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.getAttribute("points")).toBe("2,27 118,3");
    expect(lines[1]?.getAttribute("points")).toBe("2,15");
    expect(within(wellness).getByText("70 ms")).toBeInTheDocument();
    expect(within(wellness).getByText("7h 30m")).toBeInTheDocument();
    expect(within(wellness).getAllByText("No readings")).toHaveLength(2);
  });

  it("explains every unknown panel and announces loading and unavailable status", () => {
    useEnduragentStore.setState({
      training: ready({ status: "loading", metadata: null, trainingContext: unknownContext }),
    });
    render(<TrainingView />);

    expect(screen.getByText("Loading training data…")).toBeVisible();
    expect(screen.getByRole("region", { name: "Training" })).toHaveAttribute("aria-busy", "true");
    for (const copy of [
      "Sync training data to compare your recent power.",
      "Sync or import a cycling ride to review it here.",
      "No cycling FTP anchor is available",
      "No platform Load is available for the last 7 days",
      "No planned cycling workouts are available",
      "Not enough persisted data to show this yet",
      "No wellness readings are available",
    ]) {
      expect(screen.getByText(copy)).toBeInTheDocument();
    }
    expect(document.querySelector(".training-metadata")?.children).toHaveLength(0);

    update({
      training: ready({ status: "unavailable", metadata: null, trainingContext: unknownContext }),
    });
    expect(screen.getByText("Training data unavailable")).toBeVisible();
    expect(screen.getByRole("region", { name: "Training" })).not.toHaveAttribute("aria-busy");

    update({
      training: ready({
        status: "refresh-unavailable",
        metadata: null,
        trainingContext: unknownContext,
      }),
    });
    expect(screen.getByText("Refresh unavailable")).toBeVisible();
    expect(screen.getByRole("region", { name: "Training" })).not.toHaveAttribute("aria-busy");
  });
});

describe("training page sync", () => {
  it("shows the sync metadata with a machine-readable last-synced instant", () => {
    render(<TrainingView />);

    const metadata = document.querySelector(".training-metadata");
    expect([...(metadata?.children ?? [])].map((node) => node.textContent)).toEqual([
      "As of 1998-07-19",
      "fresh",
      "Last synced 1998-07-19 07:55:00 UTC",
    ]);
    expect(metadata?.querySelector("time")).toHaveAttribute("datetime", "1998-07-19T07:55:00.000Z");
  });

  it("keeps an unparsable sync instant out of the markup", () => {
    useEnduragentStore.setState({
      training: ready({
        metadata: {
          lastUpdated: "1998-07-19T08:00:00.000Z",
          lastSynced: "private-invalid-sync-value",
          freshness: "flag",
          degraded: true,
        },
      }),
    });
    render(<TrainingView />);

    const metadata = document.querySelector(".training-metadata");
    expect([...(metadata?.children ?? [])].map((node) => node.textContent)).toEqual([
      "As of 1998-07-19",
      "flag",
      "Data may be incomplete",
      "Last synced Unknown sync time",
    ]);
    expect(metadata?.querySelector("time")).toBeNull();
    expect(metadata?.textContent).not.toContain("private-invalid-sync-value");
  });

  it("routes pointer and keyboard activation at the manual sync controller", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    useEnduragentStore.setState({ syncActions: { request } });
    render(<TrainingView />);

    const action = screen.getByRole("button", { name: "Sync now" });
    await user.click(action);
    expect(request).toHaveBeenNthCalledWith(1, "pointer");

    fireEvent.click(action);
    expect(request).toHaveBeenNthCalledWith(2, "keyboard");
  });

  it("walks queued, running, success, retryable failure and protocol sync states", () => {
    useEnduragentStore.setState({ syncActions: { request: vi.fn() } });
    render(<TrainingView />);

    const message = document.querySelector(".training-sync-message");
    expect(message).toHaveAttribute("role", "status");
    expect(message).toHaveAttribute("aria-live", "polite");
    expect(message).toHaveAttribute("aria-atomic", "true");

    update({ sync: toManualSyncViewState({ status: "queued", operation: 1 }) });
    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sync now" })).toHaveAttribute("aria-busy", "true");
    expect(message).toHaveTextContent("Sync queued.");

    update({ sync: toManualSyncViewState({ status: "running", operation: 1 }) });
    expect(message).toHaveTextContent("Syncing training data…");

    update({
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 1,
        kind: "no-change",
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      }),
    });
    const settled = screen.getByRole("button", { name: "Sync again" });
    expect(settled).toBeEnabled();
    expect(settled).not.toHaveAttribute("aria-busy");
    expect(message).toHaveTextContent("Local training-data processing completed.");

    update({
      sync: toManualSyncViewState({
        status: "failed",
        operation: 1,
        kind: "partial",
        retryable: true,
      }),
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(message).toHaveTextContent(
      "Training-data processing partially completed. Try again to finish.",
    );

    update({
      sync: toManualSyncViewState({
        status: "failed",
        operation: 1,
        kind: "indeterminate",
        retryable: true,
      }),
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(message).toHaveTextContent(
      "Connection interrupted. The sync may still be finishing. Enduragent won’t retry it automatically.",
    );

    update({
      sync: toManualSyncViewState({
        status: "failed",
        operation: 1,
        kind: "protocol",
        retryable: false,
      }),
    });
    expect(screen.getByRole("button", { name: "Sync unavailable" })).toBeDisabled();
    expect(message).toHaveTextContent("Enduragent couldn’t verify the sync result.");
  });

  it("keeps Strava repair guidance out of Training", () => {
    useEnduragentStore.setState({ syncActions: { request: vi.fn() } });
    render(<TrainingView />);

    update({
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 1,
        kind: "published",
        droppedActivities: {
          overall: {
            total: 67,
            visible: 5,
            restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 60 }],
            other: 2,
          },
          recent7Days: {
            total: 5,
            visible: 1,
            restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 4 }],
            other: 0,
          },
        },
      }),
    });

    expect(document.querySelector("#strava-restricted-activities")).toBeNull();
    expect(document.querySelector(".training-sync-message")).toHaveTextContent(
      "A Strava API restriction prevents intervals.icu from sharing 60 activities",
    );

    update({
      sync: toManualSyncViewState({
        status: "succeeded",
        operation: 2,
        kind: "no-change",
        droppedActivities: {
          overall: { total: 5, visible: 5, restrictions: [], other: 0 },
          recent7Days: { total: 5, visible: 5, restrictions: [], other: 0 },
        },
      }),
    });

    expect(document.querySelector(".training-sync-message")).not.toHaveTextContent(
      "Strava API restriction",
    );
  });

  it("disables the sync action until the controller is bound", () => {
    render(<TrainingView />);

    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
  });

  it("returns keyboard focus to the sync action once a recoverable failure settles", () => {
    useEnduragentStore.setState({ syncActions: { request: vi.fn() } });
    render(<TrainingView />);

    const action = screen.getByRole("button", { name: "Sync now" });
    action.focus();
    fireEvent.click(action);
    update({ sync: toManualSyncViewState({ status: "running", operation: 1 }) });
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    update({
      sync: toManualSyncViewState({
        status: "failed",
        operation: 1,
        kind: "operation",
        retryable: true,
      }),
    });

    act(() => {
      restoreManualSyncFocus();
    });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Try again" }));
  });

  it("holds keyboard focus on the sync status when the action becomes unavailable", () => {
    useEnduragentStore.setState({ syncActions: { request: vi.fn() } });
    render(<TrainingView />);

    const action = screen.getByRole("button", { name: "Sync now" });
    action.focus();
    fireEvent.click(action);
    act(() => {
      action.blur();
    });
    update({
      sync: toManualSyncViewState({
        status: "failed",
        operation: 1,
        kind: "protocol",
        retryable: false,
      }),
    });
    expect(screen.getByRole("button", { name: "Sync unavailable" })).toBeDisabled();
    expect(document.activeElement).toBe(document.body);

    act(() => {
      restoreManualSyncFocus();
    });
    const message = document.querySelector(".training-sync-message");
    expect(message).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).toBe(message);
    expect(message).toHaveTextContent("Enduragent couldn’t verify the sync result.");
  });

  it("leaves focus alone after a pointer-activated sync", async () => {
    const user = userEvent.setup();
    useEnduragentStore.setState({ syncActions: { request: vi.fn() } });
    render(<TrainingView />);

    const action = screen.getByRole("button", { name: "Sync now" });
    await user.click(action);
    act(() => {
      action.blur();
    });
    update({
      sync: toManualSyncViewState({
        status: "failed",
        operation: 1,
        kind: "protocol",
        retryable: false,
      }),
    });

    act(() => {
      restoreManualSyncFocus();
    });
    expect(document.activeElement).toBe(document.body);
  });

  it("drops the fallback target when the training page unmounts", () => {
    useEnduragentStore.setState({ syncActions: { request: vi.fn() } });
    const view = render(<TrainingView />);

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    view.unmount();

    act(() => {
      restoreManualSyncFocus();
    });
    expect(document.activeElement).toBe(document.body);
  });
});

describe("training page ride import", () => {
  it("hands the import request to the resident controller", async () => {
    const user = userEvent.setup();
    const choose = vi.fn();
    useEnduragentStore.setState({ rideImportActions: { choose } });
    render(<TrainingView />);

    await user.click(screen.getByRole("button", { name: "Import ride files" }));
    expect(choose).toHaveBeenCalledTimes(1);
  });

  it("reports the picker, progress, success and failure stages", () => {
    useEnduragentStore.setState({ rideImportActions: { choose: vi.fn() } });
    render(<TrainingView />);

    const status = document.querySelector(".ride-import-status");
    expect(status).toHaveProperty("hidden", true);
    expect(screen.getByRole("button", { name: "Import ride files" })).toHaveAttribute(
      "aria-describedby",
      "ride-import-status",
    );

    setRideImport({
      status: "running",
      owner: "resident",
      stage: "choosing",
      progress: null,
      result: null,
    });
    expect(status).toHaveTextContent("Waiting for ride file selection…");
    expect(screen.getByRole("button", { name: "Import ride files" })).toBeDisabled();

    setRideImport({
      status: "running",
      owner: "resident",
      stage: "importing",
      progress: progressEnvelope(3),
      result: null,
    });
    expect(status).toHaveTextContent("Importing ride files…");
    expect(screen.getByText("3 of 4 files processed")).toBeInTheDocument();

    setRideImport({
      status: "succeeded",
      owner: "resident",
      progress: null,
      result: importResult(2, 1),
    });
    expect(status).toHaveTextContent(
      "Local library import: 2 ride files imported. 1 ride file quarantined. Coaching access to activities and streams is available.",
    );
    expect(status).toHaveAttribute("data-state", "succeeded");

    setRideImport({ status: "failed", owner: "resident", progress: null, result: null });
    expect(status).toHaveTextContent(
      "Local library import failed. The result could not be confirmed; check the library before trying again.",
    );
    expect(status).toHaveAttribute("data-state", "failed");
  });

  it("suppresses the resident status while setup blocks the app shell or Settings is open", () => {
    render(<TrainingView />);
    setRideImport({
      status: "running",
      owner: "onboarding",
      stage: "importing",
      progress: null,
      result: null,
    });
    update({
      rideImportSuppressed: true,
      activeView: "settings",
      onboarding: { ...READY_ONBOARDING, completionRequired: true },
    });

    const status = document.querySelector(".ride-import-status");
    expect(status).toHaveProperty("hidden", true);
    expect(status).toHaveAttribute("data-state", "idle");

    update({ activeView: "training" });
    expect(status).toHaveProperty("hidden", true);

    update({ onboarding: READY_ONBOARDING });
    expect(status).toHaveProperty("hidden", false);
    expect(status).toHaveTextContent("Importing ride files…");
  });

  it("keeps reporting imports after setup completes and the wizard stops presenting", () => {
    render(<TrainingView />);
    update({ rideImportSuppressed: true, onboarding: READY_ONBOARDING });
    setRideImport({
      status: "running",
      owner: "resident",
      stage: "importing",
      progress: null,
      result: null,
    });

    const status = document.querySelector(".ride-import-status");
    expect(status).toHaveProperty("hidden", false);
    expect(status).toHaveTextContent("Importing ride files…");
    expect(status).toHaveAttribute("data-state", "running");
  });
});
