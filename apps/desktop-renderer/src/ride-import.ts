import type {
  CoachOperationProgressNotificationEnvelope,
  ImportFilesRpcResult,
} from "@enduragent/coach-contract";
import { validateImportPaths } from "./onboarding/bridge.js";

export type RideImportOwner = "onboarding" | "resident";

type RideImportResult = ImportFilesRpcResult;

export type RideImportState =
  | {
      readonly status: "idle";
      readonly owner: null;
      readonly progress: null;
      readonly result: null;
    }
  | {
      readonly status: "running";
      readonly owner: RideImportOwner;
      readonly stage: "choosing" | "importing";
      readonly progress: CoachOperationProgressNotificationEnvelope | null;
      readonly result: null;
    }
  | {
      readonly status: "succeeded";
      readonly owner: RideImportOwner;
      readonly progress: null;
      readonly result: RideImportResult;
    }
  | {
      readonly status: "failed";
      readonly owner: RideImportOwner;
      readonly progress: null;
      readonly result: RideImportResult | null;
    };

export type RideImportAttempt = "busy" | "cancelled" | "failed" | "succeeded";

export interface RideImportTransport {
  chooseImportFiles(): Promise<readonly string[]>;
  importFiles(
    paths: readonly string[],
    onProgress: (event: CoachOperationProgressNotificationEnvelope) => void,
  ): Promise<ImportFilesRpcResult>;
}

export interface RideImportController {
  state(): RideImportState;
  isBusy(): boolean;
  importedFileCount(): number;
  subscribe(listener: (state: RideImportState) => void): () => void;
  chooseAndImport(owner: RideImportOwner): Promise<RideImportAttempt>;
  importPaths(owner: RideImportOwner, paths: readonly string[]): Promise<RideImportAttempt>;
}

const IDLE_STATE: RideImportState = {
  status: "idle",
  owner: null,
  progress: null,
  result: null,
};

export function createRideImportController(transport: RideImportTransport): RideImportController {
  let state = IDLE_STATE;
  let attempt = 0;
  let importedFileCount = 0;
  const listeners = new Set<(state: RideImportState) => void>();

  const publish = (next: RideImportState): void => {
    state = next;
    for (const listener of listeners) listener(state);
  };

  const begin = (owner: RideImportOwner, stage: "choosing" | "importing"): number | null => {
    if (state.status === "running") return null;
    const currentAttempt = ++attempt;
    publish({
      status: "running",
      owner,
      stage,
      progress: null,
      result: null,
    });
    return currentAttempt;
  };

  const fail = (owner: RideImportOwner, result: RideImportResult | null): RideImportAttempt => {
    publish({ status: "failed", owner, progress: null, result });
    return "failed";
  };

  const execute = async (
    owner: RideImportOwner,
    paths: readonly string[],
    currentAttempt: number,
  ): Promise<RideImportAttempt> => {
    try {
      const validatedPaths = validateImportPaths(paths);
      publish({
        status: "running",
        owner,
        stage: "importing",
        progress: null,
        result: null,
      });
      const result = await transport.importFiles(validatedPaths, (progress) => {
        if (attempt !== currentAttempt || state.status !== "running") return;
        publish({
          status: "running",
          owner,
          stage: "importing",
          progress,
          result: null,
        });
      });
      if (
        result.files.imported <= 0 &&
        !(result.files.total === 0 && result.publication.status === "available")
      ) {
        return fail(owner, result);
      }
      importedFileCount += result.files.imported;
      publish({
        status: "succeeded",
        owner,
        progress: null,
        result,
      });
      return "succeeded";
    } catch {
      return fail(owner, null);
    }
  };

  return {
    state: () => state,
    isBusy: () => state.status === "running",
    importedFileCount: () => importedFileCount,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    async chooseAndImport(owner) {
      const currentAttempt = begin(owner, "choosing");
      if (currentAttempt === null) return "busy";
      try {
        const paths = await transport.chooseImportFiles();
        if (paths.length === 0) {
          publish(IDLE_STATE);
          return "cancelled";
        }
        return execute(owner, paths, currentAttempt);
      } catch {
        return fail(owner, null);
      }
    },
    async importPaths(owner, paths) {
      const currentAttempt = begin(owner, "importing");
      if (currentAttempt === null) return "busy";
      return execute(owner, paths, currentAttempt);
    },
  };
}

function rideFileCount(count: number): string {
  return `${count} ride file${count === 1 ? "" : "s"}`;
}

export function rideImportStatusCopy(state: RideImportState): string {
  if (state.status === "idle") return "";
  if (state.status === "running") {
    return state.stage === "choosing"
      ? "Waiting for ride file selection…"
      : "Importing ride files…";
  }
  if (state.result === null) {
    return "Local library import failed. The result could not be confirmed; check the library before trying again.";
  }
  const counts = `${rideFileCount(state.result.files.imported)} imported. ${rideFileCount(state.result.files.quarantined)} quarantined.`;
  if (state.status === "failed") {
    return `Local library import failed. ${counts} No new ride files are available for coaching.`;
  }
  const availability =
    state.result.publication.status === "available"
      ? "Coaching access to activities and streams is available."
      : "Coaching access to activities and streams is temporarily unavailable; retry the import.";
  return `Local library import: ${counts} ${availability}`;
}

interface ResidentRideImportOptions {
  readonly document: Document;
  readonly actionHost: HTMLElement;
  readonly before?: Node;
  readonly imports: RideImportController;
}

export interface ResidentRideImport {
  importDroppedFiles(paths: readonly string[]): void;
  setSuppressed(suppressed: boolean): void;
  dispose(): void;
}

export function mountResidentRideImport(options: ResidentRideImportOptions): ResidentRideImport {
  const root = options.document.createElement("div");
  root.className = "ride-import";
  const button = options.document.createElement("button");
  button.type = "button";
  button.className = "ride-import__button";
  button.textContent = "Import ride files";
  button.setAttribute("aria-describedby", "resident-ride-import-status");
  const status = options.document.createElement("p");
  status.id = "resident-ride-import-status";
  status.className = "ride-import__status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.setAttribute("aria-atomic", "true");
  status.hidden = true;
  root.append(button, status);
  if (options.before === undefined) options.actionHost.append(root);
  else options.actionHost.insertBefore(root, options.before);

  let suppressed = false;
  const render = (state: RideImportState): void => {
    button.disabled = options.imports.isBusy();
    const copy = suppressed ? "" : rideImportStatusCopy(state);
    status.textContent = copy;
    status.hidden = copy.length === 0;
    status.dataset.state = suppressed ? "idle" : state.status;
  };
  const disposeState = options.imports.subscribe(render);
  button.addEventListener("click", () => {
    void options.imports.chooseAndImport("resident");
  });

  return {
    importDroppedFiles(paths) {
      void options.imports.importPaths("resident", paths);
    },
    setSuppressed(next) {
      suppressed = next;
      render(options.imports.state());
    },
    dispose() {
      disposeState();
      root.remove();
    },
  };
}

interface DroppedRideImportRouterOptions {
  readonly subscribe: (listener: (paths: readonly string[]) => void) => () => void;
  readonly onboarding: {
    ownsDroppedImportFiles(): boolean;
    importDroppedFiles(paths: readonly string[]): void;
  };
  readonly resident: {
    importDroppedFiles(paths: readonly string[]): void;
  };
}

export function subscribeToDroppedRideImports(options: DroppedRideImportRouterOptions): () => void {
  return options.subscribe((paths) => {
    if (options.onboarding.ownsDroppedImportFiles()) {
      options.onboarding.importDroppedFiles(paths);
    } else {
      options.resident.importDroppedFiles(paths);
    }
  });
}
