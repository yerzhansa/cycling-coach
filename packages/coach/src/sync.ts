import type { ImportReport } from "@enduragent/kernel/ingest";
import { SOURCE_IDS, type SourceId, type SyncSource } from "@enduragent/kernel/store";
import { importFilesWithReport } from "@enduragent/kernel-node/ingest";
import { withCoachStoreWriter, type CoachStoreWriterContext } from "./runtime.js";

export interface CoachSourceRunContext extends CoachStoreWriterContext {
  readonly source: SyncSource;
}

export type CoachSourceRun = (context: CoachSourceRunContext) => Promise<void>;

export interface CoachSourceBinding {
  readonly source: SyncSource;
  readonly run: CoachSourceRun;
}

export interface RunCoachSyncOptions {
  readonly env: Record<string, string | undefined>;
  readonly sources: readonly CoachSourceBinding[];
  readonly importPaths?: readonly string[];
}

export interface CoachSourceOutcome {
  readonly source_id: SourceId;
  readonly status: "completed" | "failed";
  readonly message: string | null;
}

export interface CoachSyncReport {
  readonly schema_version: 1;
  readonly sources: readonly CoachSourceOutcome[];
  readonly import_report: ImportReport | null;
}

export interface CoachSyncDependencies {
  readonly withWriter: typeof withCoachStoreWriter;
  readonly importFiles: typeof importFilesWithReport;
}

const defaultDependencies: CoachSyncDependencies = Object.freeze({
  withWriter: withCoachStoreWriter,
  importFiles: importFilesWithReport,
});

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  for (const binding of options.sources) {
    if (
      !isObject(binding) ||
      !isObject(binding.source) ||
      !SOURCE_IDS.includes(binding.source.id as SourceId) ||
      typeof binding.run !== "function"
    ) {
      throw new TypeError("invalid coach source binding");
    }
    const source = binding.source as unknown as SyncSource;
    if (sourceIds.has(source.id)) {
      throw new TypeError("duplicate coach sync source");
    }
    sourceIds.add(source.id);
    sources.push(Object.freeze({ source, run: binding.run as CoachSourceRun }));
  }
  const copiedSources = Object.freeze(sources);

  let copiedImportPaths: readonly string[];
  if (options.importPaths === undefined) {
    copiedImportPaths = Object.freeze([]);
  } else {
    if (!Array.isArray(options.importPaths)) {
      throw new TypeError("invalid coach import paths");
    }
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
  return dependencies.withWriter(options.env, async ({ home, store }) => {
    const outcomes: CoachSourceOutcome[] = [];
    for (const binding of copiedSources) {
      const context = Object.freeze({ home, store, source: binding.source });
      try {
        await binding.run(context);
        outcomes.push(
          Object.freeze({
            source_id: binding.source.id,
            status: "completed",
            message: null,
          }),
        );
      } catch {
        outcomes.push(
          Object.freeze({
            source_id: binding.source.id,
            status: "failed",
            message: "source synchronization failed",
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
      schema_version: 1,
      sources: Object.freeze(outcomes),
      import_report: importReport,
    });
  });
}
