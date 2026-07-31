import { join } from "node:path";
import type { ImportReport } from "@enduragent/kernel/ingest";
import type { FileSystemPort } from "@enduragent/kernel/ports";
import { cacheSchemas } from "@enduragent/kernel/reference/schemas";
import {
  SOURCE_IDS,
  SYNC_FAILURE_SEVERITIES,
  createSyncFailureRepository,
  nextSyncFailureOrdinal,
  reduceSyncFailures,
  type SourceCheckpoint,
  type SourceId,
  type SourceArtifact,
  type SourceWatermark,
  type SyncBudget,
  type SyncFailureDetail,
  type SyncFailureSeverity,
  type SyncSource,
} from "@enduragent/kernel/store";
import {
  createNodeImportRuntime,
  importFilesWithReport,
  type NodeImportRuntime,
} from "@enduragent/kernel-node/ingest";
import {
  ensurePrivateDirectory,
  nodeFileSystem,
  removeFileIfPresent,
} from "@enduragent/kernel-node/filesystem";
import { withCoachStoreWriter, type CoachStoreWriterContext } from "./runtime.js";

export interface CoachSourceRunContext extends CoachStoreWriterContext {
  readonly source: SyncSource;
}

export type CoachSourceRun = (context: CoachSourceRunContext) => Promise<void>;

export const COACH_SOURCE_FAILURE_CODES = Object.freeze([
  "authorization",
  "unavailable",
  "invalid-data",
  "budget-exhausted",
] as const);
export type CoachSourceFailureCode = (typeof COACH_SOURCE_FAILURE_CODES)[number];

export interface CoachSourceFailure {
  readonly severity: SyncFailureSeverity;
  readonly code: CoachSourceFailureCode;
}

export type CoachSourceFailureClassifier = (error: unknown) => CoachSourceFailure;

export interface CoachFileBatchSource extends SyncSource {
  readonly id: "file-import";
  pullBatches(
    watermark: SourceWatermark,
    budget: SyncBudget,
  ): AsyncIterable<
    | {
        readonly kind: "batch";
        readonly artifacts: readonly Extract<SourceArtifact, { readonly kind: "raw-file" }>[];
      }
    | SourceCheckpoint
  >;
}

export interface CoachFileHydration {
  readonly watermark: SourceWatermark;
  readonly budget: SyncBudget;
}

export interface CoachRunSourceBinding {
  readonly source: SyncSource;
  readonly run: CoachSourceRun;
  readonly fileHydration?: never;
  readonly classifyFailure?: CoachSourceFailureClassifier;
}

export interface CoachFileSourceBinding {
  readonly source: CoachFileBatchSource;
  readonly run?: never;
  readonly fileHydration: CoachFileHydration;
  readonly classifyFailure?: CoachSourceFailureClassifier;
}

export type CoachSourceBinding = CoachRunSourceBinding | CoachFileSourceBinding;

export interface RunCoachSyncOptions {
  readonly env: Record<string, string | undefined>;
  readonly sources: readonly CoachSourceBinding[];
  readonly importPaths?: readonly string[];
}

export interface CoachSourceOutcome {
  readonly source_id: SourceId;
  readonly status: "completed" | "failed";
  readonly severity: SyncFailureSeverity | null;
  readonly message: SyncFailureDetail | null;
}

export interface CoachSyncReport {
  readonly schema_version: 2;
  readonly sources: readonly CoachSourceOutcome[];
  readonly import_report: ImportReport | null;
}

export interface CoachSyncDependencies {
  readonly withWriter: <T>(
    env: Record<string, string | undefined>,
    run: (context: CoachStoreWriterContext) => Promise<T>,
  ) => Promise<T>;
  readonly importFiles: typeof importFilesWithReport;
  readonly fileSystem: Pick<FileSystemPort, "writeFile">;
  readonly ensurePrivateDirectory: typeof ensurePrivateDirectory;
  readonly removeFileIfPresent: typeof removeFileIfPresent;
  readonly nowEpochMs: () => number;
  readonly createImportRuntime: typeof createNodeImportRuntime;
}

const defaultDependencies: CoachSyncDependencies = Object.freeze({
  withWriter: withCoachStoreWriter,
  importFiles: importFilesWithReport,
  fileSystem: nodeFileSystem(),
  ensurePrivateDirectory,
  removeFileIfPresent,
  nowEpochMs: Date.now,
  createImportRuntime: createNodeImportRuntime,
});

const DETAIL_BY_CODE: Readonly<Record<CoachSourceFailureCode, SyncFailureDetail>> = Object.freeze({
  authorization: "source authorization failed",
  unavailable: "source temporarily unavailable",
  "invalid-data": "source data failed validation",
  "budget-exhausted": "source synchronization budget exhausted",
});

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailureSeverity(value: unknown): value is SyncFailureSeverity {
  return (SYNC_FAILURE_SEVERITIES as readonly unknown[]).includes(value);
}

function isFailureCode(value: unknown): value is CoachSourceFailureCode {
  return (COACH_SOURCE_FAILURE_CODES as readonly unknown[]).includes(value);
}

function classifyFailure(
  classifier: CoachSourceFailureClassifier | undefined,
  error: unknown,
): { readonly severity: SyncFailureSeverity; readonly detail: SyncFailureDetail } {
  if (classifier === undefined) {
    return { severity: "block", detail: "source synchronization failed" };
  }
  try {
    const value: unknown = classifier(error);
    if (value === null || typeof value !== "object")
      throw new TypeError("invalid classifier result");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("invalid classifier result");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2 ||
      keys.some((key) => typeof key !== "string" || (key !== "severity" && key !== "code")) ||
      !keys.includes("severity") ||
      !keys.includes("code")
    ) {
      throw new TypeError("invalid classifier result");
    }
    const severity = Object.getOwnPropertyDescriptor(value, "severity");
    const code = Object.getOwnPropertyDescriptor(value, "code");
    if (
      severity === undefined ||
      code === undefined ||
      !("value" in severity) ||
      !("value" in code) ||
      !severity.enumerable ||
      !code.enumerable ||
      !isFailureSeverity(severity.value) ||
      !isFailureCode(code.value)
    ) {
      throw new TypeError("invalid classifier result");
    }
    return { severity: severity.value, detail: DETAIL_BY_CODE[code.value] };
  } catch {
    return { severity: "block", detail: "source failure classification failed" };
  }
}

function validateBinding(value: unknown): CoachSourceBinding {
  if (!isObject(value) || !isObject(value.source)) {
    throw new TypeError("invalid coach source binding");
  }
  const source = value.source as unknown as SyncSource;
  const hasRun = typeof value.run === "function";
  const hasHydration = isObject(value.fileHydration);
  if (
    !SOURCE_IDS.includes(source.id as SourceId) ||
    typeof source.pull !== "function" ||
    hasRun === hasHydration ||
    (value.classifyFailure !== undefined && typeof value.classifyFailure !== "function")
  ) {
    throw new TypeError("invalid coach source binding");
  }
  if (hasRun) {
    return Object.freeze({
      source,
      run: value.run as CoachSourceRun,
      ...(value.classifyFailure === undefined
        ? {}
        : { classifyFailure: value.classifyFailure as CoachSourceFailureClassifier }),
    });
  }
  const hydration = value.fileHydration as unknown as CoachFileHydration;
  if (
    source.id !== "file-import" ||
    typeof (source as CoachFileBatchSource).pullBatches !== "function" ||
    !isObject(hydration.watermark) ||
    hydration.watermark.source !== "file-import" ||
    hydration.watermark.lane !== "file-discovery" ||
    !isObject(hydration.budget)
  ) {
    throw new TypeError("invalid coach source binding");
  }
  return Object.freeze({
    source: source as CoachFileBatchSource,
    fileHydration: Object.freeze({ watermark: hydration.watermark, budget: hydration.budget }),
    ...(value.classifyFailure === undefined
      ? {}
      : { classifyFailure: value.classifyFailure as CoachSourceFailureClassifier }),
  });
}

async function runFileHydration(
  binding: CoachFileSourceBinding,
  runtime: NodeImportRuntime,
): Promise<void> {
  let checkpointSeen = false;
  for await (const event of binding.source.pullBatches(
    binding.fileHydration.watermark,
    binding.fileHydration.budget,
  )) {
    if (checkpointSeen) throw new TypeError("source synchronization failed");
    if (event.kind === "checkpoint") {
      checkpointSeen = true;
      continue;
    }
    await runtime.importBatchWithReport({
      files: event.artifacts.map((artifact) => artifact.file),
      platform_records: [],
    });
  }
  if (!checkpointSeen) throw new TypeError("source synchronization failed");
}

export async function runCoachSync(
  options: RunCoachSyncOptions,
  deps?: CoachSyncDependencies,
): Promise<CoachSyncReport> {
  if (!isObject(options) || !isObject(options.env) || !Array.isArray(options.sources)) {
    throw new TypeError("invalid coach sync options");
  }

  const sourceIds = new Set<SourceId>();
  const sources: CoachSourceBinding[] = [];
  for (const candidate of options.sources) {
    const binding = validateBinding(candidate);
    if (sourceIds.has(binding.source.id)) throw new TypeError("duplicate coach sync source");
    sourceIds.add(binding.source.id);
    sources.push(binding);
  }
  const copiedSources = Object.freeze(sources);

  let copiedImportPaths: readonly string[];
  if (options.importPaths === undefined) {
    copiedImportPaths = Object.freeze([]);
  } else {
    if (!Array.isArray(options.importPaths)) throw new TypeError("invalid coach import paths");
    const paths = new Set<string>();
    for (const path of options.importPaths) {
      if (typeof path !== "string" || path.length === 0 || paths.has(path)) {
        throw new TypeError("invalid coach import paths");
      }
      paths.add(path);
    }
    copiedImportPaths = Object.freeze([...options.importPaths]);
  }

  const dependencies = deps ?? defaultDependencies;
  return dependencies.withWriter(options.env, async ({ home, store, listener }) => {
    const repository = createSyncFailureRepository(store);
    const target = join(home.root, "data", "error_state.json");
    const project = async (): Promise<void> => {
      const signal = reduceSyncFailures(await repository.readAll());
      if (signal === null) {
        await dependencies.removeFileIfPresent(target);
        return;
      }
      cacheSchemas.ErrorStateSchema.parse(signal);
      await dependencies.ensurePrivateDirectory(join(home.root, "data"));
      await dependencies.fileSystem.writeFile(target, `${JSON.stringify(signal, null, 2)}\n`, {
        mode: 0o600,
      });
    };

    await project();
    const outcomes: CoachSourceOutcome[] = [];
    let nodeRuntime: NodeImportRuntime | undefined;
    for (const binding of copiedSources) {
      let sourceError: unknown;
      let sourceFailed = false;
      try {
        if ("run" in binding && binding.run !== undefined) {
          await binding.run(Object.freeze({ home, store, listener, source: binding.source }));
        } else {
          nodeRuntime ??= dependencies.createImportRuntime({ archiveDir: home.archiveDir, store });
          await runFileHydration(binding as CoachFileSourceBinding, nodeRuntime);
        }
      } catch (error) {
        sourceFailed = true;
        sourceError = error;
      }
      if (!sourceFailed) {
        await store.transaction(async () => {
          await repository.clear(binding.source.id);
        });
        await project();
        outcomes.push(
          Object.freeze({
            source_id: binding.source.id,
            status: "completed",
            severity: null,
            message: null,
          }),
        );
      } else {
        const failure = classifyFailure(binding.classifyFailure, sourceError);
        await store.transaction(async () => {
          const rows = await repository.readAll();
          await repository.upsert({
            source: binding.source.id,
            severity: failure.severity,
            detail: failure.detail,
            logical_ordinal: nextSyncFailureOrdinal(rows, dependencies.nowEpochMs()),
          });
        });
        await project();
        outcomes.push(
          Object.freeze({
            source_id: binding.source.id,
            status: "failed",
            severity: failure.severity,
            message: failure.detail,
          }),
        );
      }
    }

    const importReport =
      copiedImportPaths.length === 0
        ? null
        : await dependencies.importFiles({
            inputPaths: copiedImportPaths,
            archiveDir: home.archiveDir,
            store,
          });
    return Object.freeze({
      schema_version: 2,
      sources: Object.freeze(outcomes),
      import_report: importReport,
    });
  });
}
