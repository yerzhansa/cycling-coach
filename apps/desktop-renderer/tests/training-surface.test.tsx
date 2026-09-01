import type {
  CompletedActivityWeek,
  CyclingTrainingContext,
  ImportFilesRpcResult,
  PowerProgressComputed,
  TrainingHistoryComputed,
  TrainingHistoryPanel,
  TrainingHistoryRide,
} from "@enduragent/coach-contract";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_RIDE_ANALYSIS } from "../src/activity-analysis/controller";
import type { RideImportState } from "../src/ride-import";
import { IDLE_RIDE_IMPORT } from "../src/state/ride-import-slice";
import { useEnduragentStore } from "../src/state/store";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice";
import { IDLE_TRAINING_EXPORT } from "../src/training-export/controller";
import type { TrainingContextViewState } from "../src/training-context/controller";
import { TrainingView } from "../src/ui/training/TrainingView";

const FIRST_ID = "a".repeat(64);
const SECOND_ID = "b".repeat(64);
const PREVIOUS_ID = "c".repeat(64);

function ride(overrides: Partial<TrainingHistoryRide> = {}): TrainingHistoryRide {
  return {
    id: FIRST_ID,
    title: "River tempo",
    subSport: "road",
    startEpochSeconds: 900_000_000,
    timezoneOffsetSeconds: 21_600,
    localDate: "1998-07-09",
    ridingSeconds: 5_100,
    ridingTimeBasis: "moving",
    elapsedSeconds: 5_460,
    distanceMeters: 42_120,
    load: 91,
    averagePowerWatts: 208,
    averageHeartRateBpm: 148,
    perceivedExertion: 6,
    energyKilojoules: 1_046,
    ...overrides,
  };
}

const trendBuckets = [
  ["1998-06-01", "1998-06-07", 2, 7_200],
  ["1998-06-08", "1998-06-14", 3, 10_800],
  ["1998-06-15", "1998-06-21", 0, 0],
  ["1998-06-22", "1998-06-28", 4, 14_400],
  ["1998-06-29", "1998-07-05", 2, 9_000],
  ["1998-07-06", "1998-07-12", 1, 5_400],
].map(([start, end, rideCount, ridingSeconds]) => ({
  window: { start: String(start), end: String(end) },
  rideCount: Number(rideCount),
  ridingSeconds: Number(ridingSeconds),
}));

function week(
  id: "anchor" | "previous",
  overrides: Partial<CompletedActivityWeek> = {},
): CompletedActivityWeek {
  const anchor = id === "anchor";
  return {
    id,
    window: anchor
      ? { start: "1998-07-06", end: "1998-07-12" }
      : { start: "1998-06-29", end: "1998-07-05" },
    calendarState: "closed",
    coverage: { kind: "complete" },
    totals: {
      rideCount: { kind: "computed", value: anchor ? 2 : 1 },
      ridingSeconds: { kind: "computed", value: anchor ? 8_700 : 5_400 },
      distanceMeters: { kind: "computed", value: anchor ? 66_620 : 30_000 },
      load: { kind: "computed", value: anchor ? 119 : 54 },
    },
    rides: {
      count: { kind: "exact", value: anchor ? 2 : 1 },
      items: anchor
        ? [
            ride(),
            ride({
              id: SECOND_ID,
              title: null,
              subSport: "indoor_cycling",
              startEpochSeconds: 899_900_000,
              timezoneOffsetSeconds: null,
              localDate: "1998-07-08",
              ridingSeconds: 3_600,
              ridingTimeBasis: "elapsed",
              elapsedSeconds: 3_600,
              distanceMeters: 24_500,
              load: 28,
              averagePowerWatts: null,
              averageHeartRateBpm: 121,
              perceivedExertion: 3,
              energyKilojoules: 421,
            }),
          ]
        : [
            ride({
              id: PREVIOUS_ID,
              title: "Rolling endurance",
              startEpochSeconds: 899_300_000,
              timezoneOffsetSeconds: 0,
              localDate: "1998-07-02",
              ridingSeconds: 5_400,
              elapsedSeconds: 5_700,
              distanceMeters: 30_000,
              load: 54,
            }),
          ],
      truncated: false,
    },
    trend: { kind: "computed", buckets: trendBuckets },
    callout: anchor
      ? {
          kind: "longest-ride-28d",
          rideId: FIRST_ID,
          durationSeconds: 5_100,
          window: { start: "1998-06-12", end: "1998-07-09" },
          comparisonRideCount: 6,
        }
      : null,
    ...overrides,
  };
}

function history(overrides: Partial<TrainingHistoryComputed> = {}): TrainingHistoryComputed {
  return {
    kind: "computed",
    asOf: "1998-07-12T08:00:00.000Z",
    calendarTimeZone: "Asia/Almaty",
    displayMode: "current",
    coverage: {
      kind: "contiguous",
      start: "1998-05-01",
      through: "1998-07-12",
      committedAt: "1998-07-12T07:55:00.000Z",
    },
    anchorWeek: week("anchor"),
    previousWeek: week("previous"),
    ...overrides,
  };
}

function context(panel: TrainingHistoryPanel = history()): CyclingTrainingContext {
  return {
    performanceProgress: { kind: "unavailable", reason: "insufficient-data" },
    recentRides: {
      kind: "computed",
      asOf: "1998-07-12T08:00:00.000Z",
      windowDays: 28,
      items: [
        {
          id: "d".repeat(64),
          subSport: "mountain",
          startEpochSeconds: 900_100_000,
          timezoneOffsetSeconds: 0,
          localDate: "1998-07-10",
          elapsedSeconds: 600,
          movingSeconds: 600,
          distanceMeters: 1_000,
        },
      ],
    },
    trainingHistory: panel,
    anchorZones: { kind: "unknown", reason: "missing-anchor" },
    cyclingLoad: {
      kind: "computed",
      asOf: "1998-07-12T08:00:00.000Z",
      source: "intervals.icu",
      windowDays: 7,
      value: 9_999,
      activityCount: 99,
      missingLoadCount: 0,
    },
    plan: { kind: "unknown", reason: "no-plan" },
    adherence: { kind: "unknown", reason: "insufficient-data" },
    wellnessTrend: { kind: "unknown", reason: "no-wellness" },
  };
}

function ready(
  panel: TrainingHistoryPanel = history(),
  overrides: Partial<TrainingContextViewState> = {},
): TrainingContextViewState {
  return {
    status: "ready",
    metadata: {
      lastUpdated: "1998-07-12T08:00:00.000Z",
      lastSynced: "1998-07-12T07:55:00.000Z",
      freshness: "fresh",
      degraded: false,
    },
    trainingContext: context(panel),
    unitsPreference: { status: "ready", value: "metric", source: "default" },
    ...overrides,
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

function setTraining(next: TrainingContextViewState): void {
  act(() => useEnduragentStore.getState().setTraining(next));
}

function setRideImport(next: RideImportState): void {
  act(() => useEnduragentStore.getState().setRideImport(next));
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

describe("training landing page", () => {
  it("renders the week-first section order and ignores the rollback fields", () => {
    render(<TrainingView />);

    expect(screen.getByRole("heading", { level: 1, name: "Training" })).toBeInTheDocument();
    expect(screen.getByText("Completed riding and recent rides")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import ride files" })).toBeInTheDocument();
    expect(
      [...document.querySelectorAll("[data-panel]")].map((node) => node.getAttribute("data-panel")),
    ).toEqual(["weekly-summary", "recent-rides", "power-progress"]);
    expect(screen.getByText("2h 25m")).toBeInTheDocument();
    expect(screen.getByText("66.6 km")).toBeInTheDocument();
    expect(screen.queryByText("9,999")).not.toBeInTheDocument();
    expect(screen.queryByText("Mountain bike ride")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Import ride files" })).not.toBeInTheDocument();
  });

  it("uses adjacent pressed period buttons and announces the selected period with one warning", async () => {
    const user = userEvent.setup();
    render(<TrainingView />);

    const group = screen.getByRole("group", {
      name: "Completed riding period",
    });
    const current = within(group).getByRole("button", { name: "This week" });
    const previous = within(group).getByRole("button", {
      name: "Previous week",
    });
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(previous).toHaveAttribute("aria-pressed", "false");

    await user.click(previous);

    expect(current).toHaveAttribute("aria-pressed", "false");
    expect(previous).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Previous week");
    expect(
      screen.getByText("Power progress needs rides with recorded power in both 28-day windows."),
    ).toBeInTheDocument();
  });

  it("distinguishes partial totals, missing recorded values, and complete zero", () => {
    const partialWeek = week("anchor", {
      totals: {
        rideCount: { kind: "partial", value: 2, reason: "incomplete-coverage" },
        ridingSeconds: {
          kind: "partial",
          value: 7_200,
          reason: "missing-recorded-value",
          knownRideMissingValueCount: 1,
        },
        distanceMeters: { kind: "unavailable", reason: "no-recorded-value" },
        load: { kind: "unavailable", reason: "invalid-recorded-value" },
      },
    });
    const { unmount } = render(<TrainingView />);
    setTraining(ready(history({ anchorWeek: partialWeek })));

    expect(document.querySelector('[data-summary-metric="riding-time"]')).toHaveTextContent(
      "At least 2h",
    );
    expect(document.querySelector('[data-summary-metric="ride-count"]')).toHaveTextContent(
      "At least 2 rides",
    );
    expect(document.querySelector('[data-summary-metric="distance"]')).toHaveTextContent(
      "Not recorded",
    );
    expect(document.querySelector('[data-summary-metric="load"]')).toHaveTextContent(
      "Not recorded",
    );

    unmount();
    const zeroWeek = week("anchor", {
      totals: {
        rideCount: { kind: "computed", value: 0 },
        ridingSeconds: { kind: "computed", value: 0 },
        distanceMeters: { kind: "computed", value: 0 },
        load: { kind: "computed", value: 0 },
      },
      rides: {
        count: { kind: "exact", value: 0 },
        items: [],
        truncated: false,
      },
      callout: null,
    });
    useEnduragentStore.setState({
      training: ready(history({ anchorWeek: zeroWeek })),
    });
    render(<TrainingView />);

    expect(document.querySelector('[data-summary-metric="riding-time"]')).toHaveTextContent("0m");
    expect(document.querySelector('[data-summary-metric="ride-count"]')).toHaveTextContent(
      "0 rides",
    );
    expect(document.querySelector('[data-summary-metric="distance"]')).toHaveTextContent("0 km");
    expect(document.querySelector('[data-summary-metric="load"]')).toHaveTextContent("0");
    expect(screen.getByText("No recorded rides this week.")).toBeInTheDocument();
  });

  it("renders six bars from a visible baseline and a complete accessible data table", () => {
    render(<TrainingView />);

    const figure = screen.getByRole("figure", {
      name: "Six complete weeks of riding time",
    });
    expect(figure.querySelectorAll(".training-trend-bar")).toHaveLength(6);
    const table = within(figure).getByRole("table", {
      name: "Six complete weeks of riding time data",
    });
    expect(within(table).getByText("1998-06-15 to 1998-06-21")).toBeInTheDocument();
    expect(within(table).getByText("0 rides")).toBeInTheDocument();
    expect(within(table).getByText("0m")).toBeInTheDocument();
  });

  it.each([
    ["limited-history", "Six complete weeks are needed."],
    ["incomplete-source", "Some weeks are not fully recorded."],
    ["missing-duration", "Riding time is missing for one or more rides."],
  ] as const)("renders unavailable trend reason %s", (reason, copy) => {
    const unavailable = week("anchor", {
      trend: { kind: "unavailable", reason },
    });
    useEnduragentStore.setState({
      training: ready(history({ anchorWeek: unavailable })),
    });
    render(<TrainingView />);

    expect(screen.getByText("Trend unavailable")).toBeInTheDocument();
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(document.querySelectorAll(".training-trend-bar")).toHaveLength(0);
  });

  it("renders recorded ride facts, one scoped callout, fallback title, and omitted local time", () => {
    render(<TrainingView />);

    const recent = screen.getByRole("region", { name: "Recent rides" });
    expect(within(recent).getByText("River tempo")).toBeInTheDocument();
    expect(within(recent).getByText("1998-07-09 · 22:00")).toBeInTheDocument();
    expect(within(recent).getByText("1h 25m")).toBeInTheDocument();
    expect(within(recent).getByText("42.1 km")).toBeInTheDocument();
    expect(within(recent).getByText("Load 91")).toHaveClass("max-[760px]:hidden");
    expect(within(recent).getByText("Indoor ride")).toBeInTheDocument();
    expect(within(recent).getByText("1998-07-08")).toBeInTheDocument();
    expect(within(recent).queryByText(/1998-07-08 ·/u)).not.toBeInTheDocument();
    expect(within(recent).getAllByText("Worth a look")).toHaveLength(1);
    expect(
      within(recent).getByText("Longest recorded ride in the 28 days ending 1998-07-09"),
    ).toBeInTheDocument();
  });

  it.each([
    ["exact", "Showing 50 of 57 recorded rides."],
    ["at-least", "Showing 50 of at least 1000 recorded rides."],
  ] as const)("renders %s truncation copy", (kind, expected) => {
    const items = Array.from({ length: 50 }, (_, index) =>
      ride({
        id: index.toString(16).padStart(64, "0"),
        title: `Ride ${index + 1}`,
        startEpochSeconds: 900_000_000 - index,
        localDate: "1998-07-09",
      }),
    );
    const count = kind === "exact" ? { kind, value: 57 } : { kind, value: 1_000 };
    const truncated = week("anchor", {
      rides: { count, items, truncated: true },
      callout: null,
    });
    useEnduragentStore.setState({
      training: ready(history({ anchorWeek: truncated })),
    });
    render(<TrainingView />);

    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

describe("ride review", () => {
  it.each(["{Enter}", " "])("opens by keyboard %s and restores row focus", async (key) => {
    const user = userEvent.setup();
    render(<TrainingView />);
    const opener = screen.getByRole("button", {
      name: "Open ride review: River tempo, 1998-07-09 · 22:00",
    });
    opener.focus();

    await user.keyboard(key);

    expect(screen.getByRole("heading", { level: 1, name: "Ride review" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Back to training" }));
    expect(
      screen.getByRole("button", {
        name: "Open ride review: River tempo, 1998-07-09 · 22:00",
      }),
    ).toHaveFocus();
  });

  it("shows recorded facts in order, caps key metrics at four, and lazy-starts the disclosure", async () => {
    const user = userEvent.setup();
    const start = vi.fn();
    const refresh = vi.fn();
    useEnduragentStore.setState({ rideAnalysisActions: { start, refresh } });
    render(<TrainingView />);
    await user.click(
      screen.getByRole("button", {
        name: "Open ride review: River tempo, 1998-07-09 · 22:00",
      }),
    );

    const overview = screen.getByRole("region", { name: "River tempo" });
    expect(within(overview).getByText("Road ride")).toBeInTheDocument();
    expect(within(overview).getByText("1998-07-09 · 22:00")).toBeInTheDocument();
    expect(within(overview).getByText("1h 25m")).toBeInTheDocument();
    expect(within(overview).getByText("42.1 km")).toBeInTheDocument();
    const metricLabels = [...overview.querySelectorAll("dl:nth-of-type(2) dt")].map(
      (node) => node.textContent,
    );
    expect(metricLabels).toEqual([
      "Load",
      "Average power",
      "Average heart rate",
      "Perceived exertion (0–10)",
    ]);
    expect(document.body).not.toHaveTextContent(FIRST_ID);
    expect(within(overview).queryByText("Energy")).not.toBeInTheDocument();
    expect(within(overview).getByText(/Longest recorded ride/u)).toBeInTheDocument();

    const disclosure = screen.getByText("Recorded analysis and export").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    expect(start).not.toHaveBeenCalled();

    await user.click(screen.getByText("Recorded analysis and export"));
    expect(disclosure).toHaveAttribute("open");
    expect(start).toHaveBeenCalledTimes(1);
    await user.click(screen.getByText("Recorded analysis and export"));
    await user.click(screen.getByText("Recorded analysis and export"));
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "Export ride" })).toBeInTheDocument();
  });

  it("shows elapsed fallback as secondary metadata", async () => {
    const user = userEvent.setup();
    render(<TrainingView />);
    await user.click(
      screen.getByRole("button", {
        name: "Open ride review: Indoor ride, 1998-07-08",
      }),
    );

    expect(
      screen.getByText("Elapsed time used because moving time was not recorded."),
    ).toBeInTheDocument();
  });

  it("keeps factual summary visible when every requested analysis section fails", async () => {
    const user = userEvent.setup();
    useEnduragentStore.setState({
      rideAnalysis: {
        activityId: FIRST_ID,
        status: "unavailable",
        revision: null,
        sections: {},
        loadingSections: [],
        failedSections: [
          "aerobic-drift",
          "intervals",
          "best-efforts",
          "power-distribution",
          "heart-rate-distribution",
          "power-heart-rate",
        ],
      },
      rideAnalysisActions: { start: vi.fn(), refresh: vi.fn() },
    });
    render(<TrainingView />);
    await user.click(
      screen.getByRole("button", {
        name: "Open ride review: River tempo, 1998-07-09 · 22:00",
      }),
    );
    await user.click(screen.getByText("Recorded analysis and export"));

    expect(screen.getByRole("heading", { level: 2, name: "River tempo" })).toBeInTheDocument();
    expect(screen.getAllByText(/could not be (analyzed|loaded)/u).length).toBeGreaterThan(1);
  });

  it("clears a deleted ride and focuses the Training heading", async () => {
    const user = userEvent.setup();
    render(<TrainingView />);
    await user.click(
      screen.getByRole("button", {
        name: "Open ride review: River tempo, 1998-07-09 · 22:00",
      }),
    );
    const withoutFirst = week("anchor", {
      totals: {
        rideCount: { kind: "computed", value: 1 },
        ridingSeconds: { kind: "computed", value: 3_600 },
        distanceMeters: { kind: "computed", value: 24_500 },
        load: { kind: "computed", value: 28 },
      },
      rides: {
        count: { kind: "exact", value: 1 },
        items: [ride({ id: SECOND_ID, title: null, subSport: "indoor_cycling" })],
        truncated: false,
      },
      callout: null,
    });

    setTraining(ready(history({ anchorWeek: withoutFirst })));

    expect(screen.getByRole("heading", { level: 1, name: "Training" })).toHaveFocus();
    expect(useEnduragentStore.getState().selectedRide).toBeNull();
  });
});

describe("power progress", () => {
  it("renders an accessible five-effort Power Progress comparison with secondary context", async () => {
    const user = userEvent.setup();
    setTraining(
      ready(history(), {
        trainingContext: { ...context(), performanceProgress: computedPowerProgress },
      }),
    );
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
    setTraining(
      ready(history(), {
        trainingContext: {
          ...context(),
          performanceProgress: { kind: "unavailable", reason: "invalid-data" },
        },
      }),
    );
    render(<TrainingView />);
    expect(
      screen.getByText("Power progress data could not be verified. Sync again."),
    ).toBeInTheDocument();

    setTraining(
      ready(history(), {
        trainingContext: {
          ...context(),
          performanceProgress: {
            kind: "stale",
            lastGood: { ...computedPowerProgress, freshness: "stale" },
            refreshFailure: { code: "timeout", failedAt: "1998-07-20T08:00:00.000Z" },
          },
        },
      }),
    );
    const progress = screen.getByRole("region", { name: "Power progress" });
    expect(within(progress).getByText(/latest refresh timed out/i)).toHaveTextContent(
      "The latest refresh timed out. Showing the last complete comparison. Failed 1998-07-20 08:00:00 UTC.",
    );
    expect(within(progress).getByText("Stale")).toBeInTheDocument();
    expect(within(progress).getByText("1120 W")).toBeInTheDocument();
  });
});

describe("training history states and import status", () => {
  it("renders a retained stale wrapper as last-recorded with one refresh-failure warning", () => {
    const lastGood = history({
      displayMode: "current",
      anchorWeek: week("anchor", { callout: null }),
    });
    useEnduragentStore.setState({
      training: ready({
        kind: "stale",
        failedAt: "1998-07-12T08:15:00.000Z",
        reason: "temporary-failure",
        lastGood,
      }),
    });
    render(<TrainingView />);

    expect(screen.getByRole("button", { name: "Last recorded week" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByText("Training could not be refreshed. Showing the last recorded data."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "This week" })).not.toBeInTheDocument();
    expect(screen.queryByText("Worth a look")).not.toBeInTheDocument();
    expect(screen.getByText("Recorded through 1998-07-12")).toBeInTheDocument();
  });

  it("combines stale and incomplete history into one warning", () => {
    const panel = history({
      displayMode: "last-recorded",
      coverage: {
        kind: "incomplete",
        provenStart: "1998-05-01",
        provenThrough: "1998-07-09",
        observedThrough: "1998-07-11",
        committedAt: "1998-07-12T07:55:00.000Z",
        reason: "source-degraded",
      },
      anchorWeek: week("anchor", {
        coverage: {
          kind: "incomplete",
          recordedThrough: "1998-07-09",
          reason: "source-degraded",
        },
        callout: null,
      }),
    });
    useEnduragentStore.setState({ training: ready(panel) });
    render(<TrainingView />);

    expect(
      screen.getByText(
        "Training may be out of date, and some rides may be missing. Showing recorded rides through 1998-07-09.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Some rides may be missing.")).not.toBeInTheDocument();
  });

  it("renders sparse and unavailable history without substituting legacy data", () => {
    const sparse = history({
      displayMode: "last-recorded",
      coverage: {
        kind: "sparse",
        latestKnownRideDate: "1998-07-09",
        latestImportAt: "1998-07-09T22:30:00.000Z",
      },
      anchorWeek: week("anchor", {
        coverage: {
          kind: "incomplete",
          recordedThrough: "1998-07-09",
          reason: "sparse-imports",
        },
        callout: null,
      }),
    });
    const { unmount } = render(<TrainingView />);
    setTraining(ready(sparse));
    expect(
      screen.getByText("Showing imported rides only. Earlier rides may be missing."),
    ).toBeInTheDocument();
    unmount();

    useEnduragentStore.setState({
      training: ready({ kind: "unavailable", reason: "coverage-unavailable" }),
    });
    render(<TrainingView />);
    expect(screen.getByText("Training history is not available yet.")).toBeInTheDocument();
    expect(screen.getByText("Recent rides are not available for this period.")).toBeInTheDocument();
    expect(screen.queryByText("Mountain bike ride")).not.toBeInTheDocument();
    expect(screen.queryByText("9,999")).not.toBeInTheDocument();
  });

  it("shows only non-idle import status in a polite live region", () => {
    const choose = vi.fn();
    useEnduragentStore.setState({ rideImportActions: { choose } });
    render(<TrainingView />);
    expect(screen.queryByRole("region", { name: "Import ride files" })).not.toBeInTheDocument();

    setRideImport({
      status: "running",
      owner: "resident",
      stage: "importing",
      progress: {
        jsonrpc: "2.0",
        method: "coach.operationProgress",
        params: {
          requestId: 3,
          requestMethod: "importFiles",
          event: { phase: "started", completed: 2, total: 4 },
        },
      },
      result: null,
    });
    const status = document.querySelector("#ride-import-status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Importing ride files…");
    expect(screen.getByText("2 of 4 files processed")).toBeInTheDocument();

    setRideImport({
      status: "succeeded",
      owner: "resident",
      progress: null,
      result: importResult(2, 0),
    });
    expect(screen.getByText(/2 ride files imported/u)).toBeInTheDocument();
  });
});
