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
import { READY_ONBOARDING } from "../src/state/onboarding-slice";
import { IDLE_RIDE_IMPORT } from "../src/state/ride-import-slice";
import { useEnduragentStore } from "../src/state/store";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice";
import { IDLE_TRAINING_EXPORT } from "../src/training-export/controller";
import type { TrainingContextViewState } from "../src/training-context/controller";
import { TrainingView } from "../src/ui/training/TrainingView";
import { pinDefaultLocale } from "./intl";

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

async function openFirstRide(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(
    screen.getByRole("button", {
      name: "Open ride review: River tempo, Jul 9, 1998 · 10:00 PM",
    }),
  );
}

async function openFirstRideAnalysis(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await openFirstRide(user);
  await user.click(screen.getByText("Recorded analysis and export"));
}

beforeEach(() => {
  pinDefaultLocale("en-US");
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
    onboarding: READY_ONBOARDING,
    trainingExport: IDLE_TRAINING_EXPORT,
    trainingExportActions: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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
    onboarding: READY_ONBOARDING,
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
    setTraining(
      ready(
        history({
          previousWeek: week("previous", {
            coverage: {
              kind: "incomplete",
              recordedThrough: "1998-07-04",
              reason: "source-degraded",
            },
          }),
        }),
      ),
    );
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
    const periodStatus = screen
      .getAllByRole("status")
      .find((element) => element.id !== "ride-import-status");
    expect(periodStatus).toHaveTextContent("Previous week. Some rides may be missing.");
    expect(periodStatus?.textContent?.match(/Some rides may be missing\./gu)).toHaveLength(1);
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
    expect(figure.parentElement).toHaveClass("max-[761px]:grid-cols-1", "max-[761px]:gap-[18px]");
    expect(figure).toHaveClass("max-[761px]:border-t", "max-[761px]:pt-3.5");
    expect(figure.querySelectorAll(".training-trend-bar")).toHaveLength(6);
    expect(figure.querySelector('[aria-hidden="true"]')).toHaveClass("max-[761px]:min-h-[76px]");
    const table = within(figure).getByRole("table", {
      name: "Six complete weeks of riding time data",
    });
    expect(within(figure).getByText("6/15")).toBeInTheDocument();
    expect(within(table).getByText("Jun 15, 1998 to Jun 21, 1998")).toBeInTheDocument();
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
    const datedRide = within(recent).getByText("Jul 9, 1998 · 10:00 PM");
    expect(datedRide).toBeInTheDocument();
    expect(datedRide).toHaveAttribute("datetime", "1998-07-09");
    expect(within(recent).getByText("1h 25m")).toBeInTheDocument();
    expect(within(recent).getByText("42.1 km")).toBeInTheDocument();
    expect(within(recent).getByText("Load 91")).toHaveClass("max-[761px]:hidden");
    expect(within(recent).getByText("Indoor ride")).toBeInTheDocument();
    expect(within(recent).getByText("Jul 8, 1998")).toBeInTheDocument();
    expect(within(recent).queryByText(/Jul 8, 1998 ·/u)).not.toBeInTheDocument();
    expect(within(recent).getAllByText("Worth a look")).toHaveLength(1);
    const reason = within(recent).getByText(
      "Longest recorded ride in the 28 days ending Jul 9, 1998",
    );
    expect(reason).toHaveClass("[overflow-wrap:anywhere]", "whitespace-normal");
    expect(reason).not.toHaveClass("text-ellipsis", "whitespace-nowrap");
  });

  it("uses the units preference across the weekly summary, ride row, and Ride review", async () => {
    const user = userEvent.setup();
    setTraining(
      ready(history(), {
        unitsPreference: { status: "ready", value: "imperial", source: "athlete" },
      }),
    );
    render(<TrainingView />);

    expect(document.querySelector('[data-summary-metric="distance"]')).toHaveTextContent("41.4 mi");
    expect(
      within(screen.getByRole("region", { name: "Recent rides" })).getByText("26.2 mi"),
    ).toBeInTheDocument();

    await openFirstRide(user);

    expect(
      within(screen.getByRole("region", { name: "River tempo" })).getByText("26.2 mi"),
    ).toBeInTheDocument();
  });

  it.each([
    ["exact", 50, "Showing 50 of 57 recorded rides."],
    ["at-least", 50, "Showing 50 of at least 1000 recorded rides."],
  ] as const)("renders %s truncation copy", (kind, shown, expected) => {
    const items = Array.from({ length: shown }, (_, index) =>
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

  it("uses the actual shown count and hides truncation copy when no rides are shown", () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      ride({
        id: index.toString(16).padStart(64, "0"),
        title: `Ride ${index + 1}`,
        startEpochSeconds: 900_000_000 - index,
        localDate: "1998-07-09",
      }),
    );
    const truncated = week("anchor", {
      rides: { count: { kind: "exact", value: 57 }, items, truncated: true },
      callout: null,
    });
    const { unmount } = render(<TrainingView />);
    setTraining(ready(history({ anchorWeek: truncated })));

    expect(screen.getByText("Showing 7 of 57 recorded rides.")).toBeInTheDocument();

    unmount();
    useEnduragentStore.setState({
      training: ready(
        history({
          anchorWeek: week("anchor", {
            rides: { count: { kind: "at-least", value: 57 }, items: [], truncated: true },
            callout: null,
          }),
        }),
      ),
    });
    render(<TrainingView />);

    expect(screen.getByText("No recorded rides this week.")).toBeInTheDocument();
    expect(screen.queryByText(/Showing .* recorded rides\./u)).not.toBeInTheDocument();
  });
});

describe("ride review", () => {
  it.each(["{Enter}", " "])("opens by keyboard %s and restores row focus", async (key) => {
    const user = userEvent.setup();
    render(<TrainingView />);
    const opener = screen.getByRole("button", {
      name: "Open ride review: River tempo, Jul 9, 1998 · 10:00 PM",
    });
    opener.focus();

    await user.keyboard(key);

    expect(screen.getByRole("heading", { level: 1, name: "Ride review" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Back to training" }));
    expect(
      screen.getByRole("button", {
        name: "Open ride review: River tempo, Jul 9, 1998 · 10:00 PM",
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
        name: "Open ride review: River tempo, Jul 9, 1998 · 10:00 PM",
      }),
    );

    const overview = screen.getByRole("region", { name: "River tempo" });
    expect(overview).toHaveClass("[&_h2]:leading-8");
    expect(within(overview).getByText("Road ride")).toBeInTheDocument();
    const reviewDate = within(overview).getByText("Jul 9, 1998 · 10:00 PM");
    expect(reviewDate).toBeInTheDocument();
    expect(reviewDate).toHaveAttribute("datetime", "1998-07-09");
    expect(within(overview).getByText("1h 25m")).toBeInTheDocument();
    expect(within(overview).getByText("42.1 km")).toBeInTheDocument();
    const rideSummary = overview.querySelector("dl:first-of-type");
    expect(rideSummary).toHaveClass("mt-[calc(var(--row-inset)+var(--inset))]", "gap-3.5");
    const recordedMetrics = overview.querySelector("dl:nth-of-type(2)");
    expect(recordedMetrics).toHaveClass("max-[761px]:grid-cols-2");
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

  it("offers FIT and GPX and exports a ride without rendering its canonical ID", async () => {
    const user = userEvent.setup();
    const exportActivity = vi.fn(async () => {});
    const exportWorkoutArchive = vi.fn(async () => {});
    useEnduragentStore.setState({
      trainingExportActions: { exportActivity, exportWorkoutArchive },
    });
    render(<TrainingView />);

    await openFirstRideAnalysis(user);

    const panel = screen.getByRole("region", { name: "Export ride" });
    await user.click(within(panel).getByRole("combobox", { name: "File format" }));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual([
      "FIT",
      "GPX",
    ]);
    await user.click(screen.getByRole("option", { name: "GPX" }));
    await user.click(within(panel).getByRole("button", { name: "Export ride" }));
    expect(exportActivity).toHaveBeenCalledWith({
      canonicalActivityId: FIRST_ID,
      localDate: "1998-07-09",
      format: "gpx",
    });
    expect(document.body).not.toHaveTextContent(FIRST_ID);

    act(() => {
      useEnduragentStore.setState({
        trainingExport: { status: "saved", target: "activity", byteLength: 4_096 },
      });
    });
    expect(within(panel).getByRole("status")).toHaveTextContent("Export saved locally.");
  });

  it("shows elapsed fallback as secondary metadata", async () => {
    const user = userEvent.setup();
    render(<TrainingView />);
    await user.click(
      screen.getByRole("button", {
        name: "Open ride review: Indoor ride, Jul 8, 1998",
      }),
    );

    expect(
      screen.getByText("Elapsed time used because moving time was not recorded."),
    ).toBeInTheDocument();
  });

  it("shows a neutral, time-weighted local aerobic drift estimate with its limitations", async () => {
    const user = userEvent.setup();
    useEnduragentStore.setState({
      rideAnalysis: {
        activityId: FIRST_ID,
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
              observedAt: "1998-07-12T08:00:00.000Z",
            },
          },
        },
      },
    });
    render(<TrainingView />);

    await openFirstRideAnalysis(user);

    const panel = screen.getByRole("region", { name: "Local aerobic drift estimate" });
    expect(within(panel).getByText("+4.8%")).toHaveAccessibleName(
      "Observed efficiency-factor change +4.8%",
    );
    expect(within(panel).getByText("1.46 EF")).toBeInTheDocument();
    expect(within(panel).getByText("1.39 EF")).toBeInTheDocument();
    expect(within(panel).getByText(/92% usable time/u)).toBeInTheDocument();
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
    expect(document.body).not.toHaveTextContent(FIRST_ID);
  });

  it("shows ordered intervals and explicitly scoped five-minute best efforts", async () => {
    const user = userEvent.setup();
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
      observedAt: "1998-07-12T08:00:00.000Z",
    };
    useEnduragentStore.setState({
      rideAnalysis: {
        activityId: FIRST_ID,
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

    await openFirstRideAnalysis(user);

    const intervals = screen.getByRole("region", { name: "Intervals and laps" });
    expect(within(intervals).getByText("Threshold")).toBeInTheDocument();
    expect(within(intervals).getByText("Recovery")).toBeInTheDocument();
    expect(within(intervals).getByText("250 avg · 310 max W")).toBeInTheDocument();
    expect(within(intervals).getAllByLabelText("Unavailable").length).toBeGreaterThan(0);
    expect(intervals).toHaveTextContent("no planned workout targets are inferred");

    const efforts = screen.getByRole("region", { name: "Five-minute best efforts" });
    expect(within(efforts).getByText("#1")).toBeInTheDocument();
    expect(within(efforts).getByText("310 W")).toBeInTheDocument();
    expect(within(efforts).getByText(/This ride · power · 5 min/u)).toBeInTheDocument();
    expect(efforts).toHaveTextContent("does not compare against other rides");
    expect(efforts).not.toHaveTextContent(/\bPR\b/u);
    expect(document.body).not.toHaveTextContent(FIRST_ID);
  });

  it("shows independent accessible distributions and a distinct server power/HR response", async () => {
    const user = userEvent.setup();
    const provenance = {
      source: "provider" as const,
      delivery: "live" as const,
      observedAt: "1998-07-12T08:00:00.000Z",
    };
    useEnduragentStore.setState({
      rideAnalysis: {
        activityId: FIRST_ID,
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

    await openFirstRideAnalysis(user);

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
    expect(document.body).not.toHaveTextContent(FIRST_ID);
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
        name: "Open ride review: River tempo, Jul 9, 1998 · 10:00 PM",
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
        name: "Open ride review: River tempo, Jul 9, 1998 · 10:00 PM",
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

  it("retains a selected ride outside the authoritative returned weeks", () => {
    const selected = ride({
      id: PREVIOUS_ID,
      title: "Earlier endurance",
      localDate: "1998-07-02",
    });
    act(() => useEnduragentStore.getState().openRide(selected));
    const emptyWeek = (
      id: "anchor" | "previous",
      window: { readonly start: string; readonly end: string },
    ): CompletedActivityWeek =>
      week(id, {
        window,
        totals: {
          rideCount: { kind: "computed", value: 0 },
          ridingSeconds: { kind: "computed", value: 0 },
          distanceMeters: { kind: "computed", value: 0 },
          load: { kind: "computed", value: 0 },
        },
        rides: { count: { kind: "exact", value: 0 }, items: [], truncated: false },
        callout: null,
      });

    setTraining(
      ready(
        history({
          anchorWeek: emptyWeek("anchor", {
            start: "1998-07-13",
            end: "1998-07-19",
          }),
          previousWeek: emptyWeek("previous", {
            start: "1998-07-06",
            end: "1998-07-12",
          }),
        }),
      ),
    );
    render(<TrainingView />);

    expect(useEnduragentStore.getState().selectedRide).toEqual(selected);
    expect(
      screen.getByRole("heading", { level: 2, name: "Earlier endurance" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["unavailable", { kind: "unavailable", reason: "temporary-failure" }],
    [
      "stale",
      {
        kind: "stale",
        failedAt: "1998-07-12T08:15:00.000Z",
        reason: "temporary-failure",
        lastGood: history(),
      },
    ],
    [
      "incomplete",
      history({
        anchorWeek: week("anchor", {
          coverage: {
            kind: "incomplete",
            recordedThrough: "1998-07-08",
            reason: "coverage-lag",
          },
          totals: {
            rideCount: { kind: "partial", value: 1, reason: "incomplete-coverage" },
            ridingSeconds: { kind: "partial", value: 3_600, reason: "incomplete-coverage" },
            distanceMeters: { kind: "partial", value: 24_500, reason: "incomplete-coverage" },
            load: { kind: "partial", value: 28, reason: "incomplete-coverage" },
          },
          rides: {
            count: { kind: "at-least", value: 1 },
            items: [ride({ id: SECOND_ID })],
            truncated: true,
          },
          callout: null,
        }),
      }),
    ],
    [
      "truncated",
      history({
        anchorWeek: week("anchor", {
          rides: {
            count: { kind: "at-least", value: 1 },
            items: [ride({ id: SECOND_ID })],
            truncated: true,
          },
          callout: null,
        }),
      }),
    ],
  ] as const)("retains a selected ride when history is %s", (_label, panel) => {
    const selected = ride();
    act(() => useEnduragentStore.getState().openRide(selected));

    setTraining(ready(panel));
    render(<TrainingView />);

    expect(useEnduragentStore.getState().selectedRide).toEqual(selected);
    expect(screen.getByRole("heading", { level: 2, name: "River tempo" })).toBeInTheDocument();
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
      within(progress).getByText("Jun 22, 1998–Jul 19, 1998 · compared with the prior 28 days"),
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
      "The latest refresh timed out. Showing the last complete comparison. Failed Jul 20, 1998, 8:00 AM.",
    );
    expect(within(progress).getByText("Stale")).toBeInTheDocument();
    expect(within(progress).getByText("1120 W")).toBeInTheDocument();
  });
});

describe("training history states and import status", () => {
  it("sets Page busy only while training status is loading", () => {
    setTraining(ready(history(), { status: "loading" }));
    render(<TrainingView />);

    const page = screen.getByRole("region", { name: "Training" });
    expect(page).toHaveAttribute("aria-busy", "true");

    setTraining(ready(history(), { status: "unavailable" }));
    expect(page).not.toHaveAttribute("aria-busy");
    expect(screen.getByText("Training data unavailable")).toBeVisible();

    setTraining(ready(history(), { status: "refresh-unavailable" }));
    expect(page).not.toHaveAttribute("aria-busy");
    expect(screen.getByText("Refresh unavailable")).toBeVisible();
    expect(screen.queryByText("Training data unavailable")).not.toBeInTheDocument();
  });

  it("renders one training notice with failure, history, then degraded precedence", () => {
    const stalePanel: TrainingHistoryPanel = {
      kind: "stale",
      failedAt: "1998-07-12T08:15:00.000Z",
      reason: "temporary-failure",
      lastGood: history(),
    };
    setTraining(
      ready(stalePanel, {
        status: "refresh-unavailable",
        metadata: {
          lastUpdated: "1998-07-12T08:00:00.000Z",
          lastSynced: "1998-07-12T07:55:00.000Z",
          freshness: "flag",
          degraded: true,
        },
      }),
    );
    render(<TrainingView />);

    expect(screen.getByText("Refresh unavailable")).toBeVisible();
    expect(
      screen.queryByText("Training could not be refreshed. Showing the last recorded data."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Data may be incomplete")).not.toBeInTheDocument();

    setTraining(
      ready(stalePanel, {
        metadata: {
          lastUpdated: "1998-07-12T08:00:00.000Z",
          lastSynced: "1998-07-12T07:55:00.000Z",
          freshness: "flag",
          degraded: true,
        },
      }),
    );
    expect(
      screen.getByText("Training could not be refreshed. Showing the last recorded data."),
    ).toBeVisible();
    expect(screen.queryByText("Data may be incomplete")).not.toBeInTheDocument();

    setTraining(
      ready(history(), {
        metadata: {
          lastUpdated: "1998-07-12T08:00:00.000Z",
          lastSynced: "1998-07-12T07:55:00.000Z",
          freshness: "flag",
          degraded: true,
        },
      }),
    );
    expect(screen.getByText("Data may be incomplete")).toBeVisible();
    expect(screen.queryByText("Refresh unavailable")).not.toBeInTheDocument();
  });

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
    expect(screen.getByText("Recorded through Jul 12, 1998")).toBeInTheDocument();
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
        "Training may be out of date, and some rides may be missing. Showing recorded rides through Jul 9, 1998.",
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

  it("reports the picker, progress, success and failure stages", () => {
    const choose = vi.fn();
    useEnduragentStore.setState({ rideImportActions: { choose } });
    render(<TrainingView />);
    expect(screen.queryByRole("region", { name: "Import ride files" })).not.toBeInTheDocument();
    const status = document.querySelector("#ride-import-status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveClass("sr-only");
    expect(status).toBeEmptyDOMElement();

    setRideImport({
      status: "running",
      owner: "resident",
      stage: "choosing",
      progress: null,
      result: null,
    });
    expect(status).toHaveTextContent("Waiting for ride file selection…");
    expect(screen.getByRole("button", { name: "Import ride files" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Import ride files" })).toHaveAttribute(
      "aria-describedby",
      "ride-import-status",
    );

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
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("Importing ride files…");
    expect(screen.getByText("2 of 4 files processed")).toBeInTheDocument();

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

  it("suppresses the resident status while onboarding presents the import flow", () => {
    render(<TrainingView />);
    setRideImport({
      status: "running",
      owner: "onboarding",
      stage: "importing",
      progress: null,
      result: null,
    });
    act(() => {
      useEnduragentStore.setState({
        rideImportSuppressed: true,
        onboarding: { ...READY_ONBOARDING, completionRequired: true },
      });
    });

    const status = document.querySelector("#ride-import-status");
    expect(status).toHaveClass("sr-only");
    expect(status).toBeEmptyDOMElement();
    expect(status).toHaveAttribute("data-state", "idle");
    expect(screen.queryByRole("region", { name: "Import ride files" })).not.toBeInTheDocument();

    act(() => {
      useEnduragentStore.setState({ rideImportSuppressed: false });
    });
    expect(status).toHaveTextContent("Importing ride files…");
    expect(screen.getByRole("region", { name: "Import ride files" })).toBeInTheDocument();
  });
});
