import type {
  ActivityExportFormat,
  DesktopTrainingExportRequest,
  DesktopTrainingExportResult,
  TrainingExportRefusalReason,
  WorkoutArchiveFormat,
} from "@enduragent/coach-contract";

export type TrainingExportTarget = "activity" | "workout-archive";

export type TrainingExportState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly target: TrainingExportTarget }
  | {
      readonly status: "saved";
      readonly target: TrainingExportTarget;
      readonly byteLength: number;
    }
  | { readonly status: "cancelled"; readonly target: TrainingExportTarget }
  | {
      readonly status: "refused";
      readonly target: TrainingExportTarget;
      readonly reason: TrainingExportRefusalReason;
    };

export const IDLE_TRAINING_EXPORT: TrainingExportState = Object.freeze({ status: "idle" });

export interface TrainingExportTransport {
  exportTrainingFile(request: DesktopTrainingExportRequest): Promise<DesktopTrainingExportResult>;
}

export interface TrainingExportView {
  render(state: TrainingExportState): void;
}

export interface TrainingExportController {
  exportActivity(input: {
    readonly canonicalActivityId: string;
    readonly localDate: string;
    readonly format: ActivityExportFormat;
  }): Promise<void>;
  exportWorkoutArchive(input: {
    readonly oldest: string;
    readonly newest: string;
    readonly format: WorkoutArchiveFormat;
  }): Promise<void>;
}

export function createTrainingExportController(input: {
  readonly transport: TrainingExportTransport;
  readonly view: TrainingExportView;
}): TrainingExportController {
  let running = false;

  const run = async (
    target: TrainingExportTarget,
    request: DesktopTrainingExportRequest,
  ): Promise<void> => {
    if (running) return;
    running = true;
    input.view.render({ status: "running", target });
    try {
      const result = await input.transport.exportTrainingFile(request);
      input.view.render({ ...result, target });
    } catch {
      input.view.render({ status: "refused", target, reason: "write-failed" });
    } finally {
      running = false;
    }
  };

  return Object.freeze({
    exportActivity(request: Parameters<TrainingExportController["exportActivity"]>[0]) {
      return run("activity", { kind: "activity", ...request });
    },
    exportWorkoutArchive(request: Parameters<TrainingExportController["exportWorkoutArchive"]>[0]) {
      return run("workout-archive", { kind: "workout-archive", ...request });
    },
  });
}

export function trainingExportStatusCopy(state: TrainingExportState): string {
  if (state.status === "idle") return "";
  if (state.status === "running") return "Choose where to save the file.";
  if (state.status === "saved") return "Export saved locally.";
  if (state.status === "cancelled") return "Export cancelled. No file was changed.";
  const copy: Record<TrainingExportRefusalReason, string> = {
    "not-configured": "Connect your training account before exporting.",
    "source-not-found": "This ride is no longer available to export.",
    "ambiguous-source": "This ride could not be matched safely. Sync and try again.",
    "provider-unavailable": "The training service is temporarily unavailable.",
    "not-supported": "That export format is not available for this item.",
    "rate-limited": "The training service is busy. Try again shortly.",
    network: "The export could not be downloaded. Check your connection and try again.",
    timeout: "The export took too long. Try again.",
    "response-too-large": "The export was too large to save safely.",
    "invalid-response": "The downloaded export could not be verified.",
    "write-failed": "The export could not be saved to that location.",
    "commit-uncertain": "The save result is uncertain. Check the chosen location before retrying.",
  };
  return copy[state.reason];
}
