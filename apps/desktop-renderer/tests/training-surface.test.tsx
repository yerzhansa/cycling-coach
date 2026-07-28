import type {
  CoachOperationProgressNotificationEnvelope,
  CyclingTrainingContext,
  ImportFilesRpcResult,
} from "@enduragent/coach-contract";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RideImportState } from "../src/ride-import.js";
import { IDLE_RIDE_IMPORT } from "../src/state/ride-import-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import { IDLE_MANUAL_SYNC } from "../src/state/sync-slice.js";
import { EMPTY_TRAINING_SURFACE } from "../src/state/training-slice.js";
import type { TrainingContextViewState } from "../src/training-context/controller.js";
import { toManualSyncViewState } from "../src/training-context/manual-sync.js";
import { TrainingView } from "../src/ui/training/TrainingView.js";

function planItem(index: number) {
  return {
    id: `plan-${index}`,
    date: `1998-07-${String(10 + index).padStart(2, "0")}`,
    name: `Endurance ride ${index}`,
    category: "WORKOUT" as const,
    workoutType: "Ride",
  };
}

const context: CyclingTrainingContext = {
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
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    rideImport: IDLE_RIDE_IMPORT,
    rideImportSuppressed: false,
    rideImportActions: null,
  });
});

afterEach(() => {
  useEnduragentStore.setState({
    activeView: "chat",
    training: EMPTY_TRAINING_SURFACE,
    sync: IDLE_MANUAL_SYNC,
    syncActions: null,
    rideImport: IDLE_RIDE_IMPORT,
    rideImportSuppressed: false,
    rideImportActions: null,
  });
});

describe("training page", () => {
  it("renders every panel in the pinned order with the training data as of its own timestamps", () => {
    render(<TrainingView />);

    expect(screen.getByRole("region", { name: "Training" })).toBeInTheDocument();
    const headings = [...document.querySelectorAll("[data-panel] h2")];
    expect(headings.map((node) => node.textContent)).toEqual([
      "Sync",
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
    expect(document.querySelector(".training-status")).toHaveProperty("hidden", true);
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

  it("explains every unknown panel and announces the loading status", () => {
    useEnduragentStore.setState({
      training: ready({ status: "loading", metadata: null, trainingContext: unknownContext }),
    });
    render(<TrainingView />);

    expect(screen.getByText("Loading training data…")).toBeVisible();
    expect(screen.getByRole("region", { name: "Training" })).toHaveAttribute("aria-busy", "true");
    for (const copy of [
      "No cycling FTP anchor is available",
      "No platform Load is available for the last 7 days",
      "No planned cycling workouts are available",
      "Not enough persisted data to show this yet",
      "No wellness readings are available",
    ]) {
      expect(screen.getByText(copy)).toBeInTheDocument();
    }
    expect(document.querySelector(".training-metadata")?.children).toHaveLength(0);
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
    expect(metadata?.querySelector("time")).toHaveAttribute(
      "datetime",
      "1998-07-19T07:55:00.000Z",
    );
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

  it("walks the queued, running and terminal sync states", () => {
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
      sync: toManualSyncViewState({ status: "succeeded", operation: 1, kind: "no-change" }),
    });
    const settled = screen.getByRole("button", { name: "Sync again" });
    expect(settled).toBeEnabled();
    expect(settled).not.toHaveAttribute("aria-busy");
    expect(message).toHaveTextContent("Local training-data processing completed.");

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

  it("disables the sync action until the controller is bound", () => {
    render(<TrainingView />);

    expect(screen.getByRole("button", { name: "Sync now" })).toBeDisabled();
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

  it("suppresses the resident status while onboarding owns the import surface", () => {
    render(<TrainingView />);
    setRideImport({
      status: "running",
      owner: "onboarding",
      stage: "importing",
      progress: null,
      result: null,
    });
    update({ rideImportSuppressed: true });

    const status = document.querySelector(".ride-import-status");
    expect(status).toHaveProperty("hidden", true);
    expect(status).toHaveAttribute("data-state", "idle");

    update({ rideImportSuppressed: false });
    expect(status).toHaveProperty("hidden", false);
    expect(status).toHaveTextContent("Importing ride files…");
  });
});
