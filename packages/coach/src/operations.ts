import {
  ImportFilesRpcParamsSchema,
  ImportFilesRpcResultSchema,
  OperationProgressEventSchema,
  SyncRpcParamsSchema,
  SyncRpcResultSchema,
  type CoachOperations,
  type ImportFilesRpcParams,
  type ImportFilesRpcResult,
  type OperationProgressEvent,
  type SyncRpcParams,
  type SyncRpcResult,
} from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { importFilesWithReport } from "@enduragent/kernel-node/ingest";
import type { LocalStoreRuntime } from "./composition.js";
import type { CoachStoreWriterContext } from "./runtime.js";

export interface CreateCoachOperationsInput {
  readonly home: AthleteHome;
  readonly context: CoachStoreWriterContext;
  readonly runtime: Pick<LocalStoreRuntime, "runWindow">;
}

export interface CoachOperationsDependencies {
  readonly importFiles: typeof importFilesWithReport;
}

function sameHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

export function createCoachOperations(
  input: CreateCoachOperationsInput,
  dependencies: CoachOperationsDependencies = { importFiles: importFilesWithReport },
): CoachOperations {
  if (!sameHome(input.home, input.context.home)) {
    throw new TypeError("Writer home does not match the selected athlete home.");
  }
  const store = input.context.store;
  const archiveDir = input.home.archiveDir;
  let tail = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const task = tail.then(operation, operation);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };

  const deliver = (
    onEvent: ((event: OperationProgressEvent) => void) | undefined,
    event: OperationProgressEvent,
  ): void => {
    const parsed = OperationProgressEventSchema.parse(event);
    try {
      onEvent?.(parsed);
    } catch {}
  };

  return {
    importFiles(request: ImportFilesRpcParams, onEvent): Promise<ImportFilesRpcResult> {
      const parsedRequest = ImportFilesRpcParamsSchema.parse(request);
      const paths = [...parsedRequest.paths];
      return enqueue(async () => {
        deliver(onEvent, { phase: "started", completed: 0, total: paths.length });
        const report = await dependencies.importFiles({ inputPaths: paths, archiveDir, store });
        const result = ImportFilesRpcResultSchema.parse({
          schemaVersion: 1,
          files: {
            total: report.files.length,
            imported: report.files.filter((file) => file.outcome === "imported").length,
            quarantined: report.files.filter((file) => file.outcome === "quarantined").length,
          },
          changes: {
            rawFilesInserted: report.inserts.raw_file,
            sourceRecordsInserted: report.inserts.source_record,
            sourceRecordsUpdated: report.updates.source_record,
            relinkedSourceRecords: report.updates.relinked_source_records,
          },
        });
        deliver(onEvent, { phase: "completed", completed: paths.length, total: paths.length });
        return result;
      });
    },
    sync(request: SyncRpcParams, onEvent): Promise<SyncRpcResult> {
      SyncRpcParamsSchema.parse(request);
      return enqueue(async () => {
        deliver(onEvent, { phase: "started", completed: 0, total: 1 });
        const window = await input.runtime.runWindow();
        const result = SyncRpcResultSchema.parse({
          schemaVersion: 1,
          published: window.published,
          referenceSucceeded: window.legacySucceeded,
          requests: {
            store: window.counts.storeRequests,
            reference: window.counts.legacyRequests,
            total: window.counts.totalRequests,
          },
        });
        deliver(onEvent, { phase: "completed", completed: 1, total: 1 });
        return result;
      });
    },
  };
}
