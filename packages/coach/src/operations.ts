import {
  ConfigureRuntimeRpcParamsSchema,
  ConfigureRuntimeRpcResultSchema,
  ImportFilesRpcParamsSchema,
  ImportFilesRpcResultSchema,
  OperationProgressEventSchema,
  SaveIntakeRpcParamsSchema,
  SaveIntakeRpcResultSchema,
  SyncRpcParamsSchema,
  SyncRpcResultSchema,
  type ConfigureRuntimeRpcParams,
  type ConfigureRuntimeRpcResult,
  type CoachOperations,
  type ImportFilesRpcParams,
  type ImportFilesRpcResult,
  type OperationProgressEvent,
  type SaveIntakeRpcParams,
  type SaveIntakeRpcResult,
  type SyncRpcParams,
  type SyncRpcResult,
} from "@enduragent/coach-contract";
import { createIntakeRepository } from "@enduragent/kernel/store";
import {
  createAuthoredIdentity,
  type AthleteHome,
  type AuthoredIdentity,
} from "@enduragent/kernel-node/home";
import { importFilesWithReport } from "@enduragent/kernel-node/ingest";
import { runIntervalsBackfillInWriter } from "./backfill.js";
import type { LocalStoreRuntime } from "./composition.js";
import type { CoachStoreWriterContext } from "./runtime.js";

export interface CreateCoachOperationsInput {
  readonly home: AthleteHome;
  readonly context: CoachStoreWriterContext;
  readonly runtime: Pick<LocalStoreRuntime, "runWindowAfter">;
  readonly intervalsCredentials: Readonly<{
    read(): Promise<Readonly<{ apiKey: string; athleteId: string }>>;
  }>;
  readonly historyNewestDate: string;
  readonly applyRuntimeConfig: (request: ConfigureRuntimeRpcParams) => Promise<void>;
}

export interface CoachOperationsDependencies {
  readonly importFiles?: typeof importFilesWithReport;
  readonly backfill?: typeof runIntervalsBackfillInWriter;
  readonly createIdentity?: (configDir: string) => AuthoredIdentity;
  readonly createIntakeRepository?: typeof createIntakeRepository;
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
  dependencies: CoachOperationsDependencies = {},
): CoachOperations {
  if (!sameHome(input.home, input.context.home)) {
    throw new TypeError("Writer home does not match the selected athlete home.");
  }
  const store = input.context.store;
  const archiveDir = input.home.archiveDir;
  const identity = (dependencies.createIdentity ?? createAuthoredIdentity)(input.home.configDir);
  const intake = (dependencies.createIntakeRepository ?? createIntakeRepository)(store);
  const importFiles = dependencies.importFiles ?? importFilesWithReport;
  const backfill = dependencies.backfill ?? runIntervalsBackfillInWriter;
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
        const report = await importFiles({ inputPaths: paths, archiveDir, store });
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
        const window = await input.runtime.runWindowAfter(async (signal) => {
          const credentials = await input.intervalsCredentials.read();
          if (credentials.apiKey.length === 0) return;
          await backfill({
            home: input.home,
            store: input.context.store,
            apiKey: credentials.apiKey,
            athleteId: credentials.athleteId === "" ? "0" : credentials.athleteId,
            historyNewestDate: input.historyNewestDate,
            signal,
          });
        });
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
    saveIntake(request: SaveIntakeRpcParams): Promise<SaveIntakeRpcResult> {
      const parsedRequest = SaveIntakeRpcParamsSchema.parse(request);
      return enqueue(async () => {
        const deviceId = await identity.deviceId();
        const stamp = identity.hlcStamp();
        await intake.replace({
          id: identity.newUlid(),
          ...parsedRequest,
          device_id: deviceId,
          hlc_physical_ms: stamp.physicalMs,
          hlc_counter: stamp.counter,
        });
        return SaveIntakeRpcResultSchema.parse({ schemaVersion: 1, saved: true });
      });
    },
    configureRuntime(request: ConfigureRuntimeRpcParams): Promise<ConfigureRuntimeRpcResult> {
      const parsedRequest = ConfigureRuntimeRpcParamsSchema.parse(request);
      return enqueue(async () => {
        await input.applyRuntimeConfig(parsedRequest);
        return ConfigureRuntimeRpcResultSchema.parse({
          schemaVersion: 1,
          applied: {
            llm: parsedRequest.llm !== undefined,
            intervals: parsedRequest.intervals !== undefined,
          },
        });
      });
    },
  };
}
