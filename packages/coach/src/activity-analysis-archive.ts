import { canonicalJson, type ArchiveManager } from "@enduragent/kernel/archive";
import type { IntervalsSourceRepository, SqlStore } from "@enduragent/kernel/store";
import type { ActivityIntervals, BestEfforts } from "intervals-icu-api";
import type {
  ProviderActivityStreamArchive,
  ProviderActivityStreamArchiveRequest,
} from "./activity-analysis-provider.js";

interface TransactionalStore extends SqlStore {
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

interface ProviderActivityAnalysisArchiveDependencies {
  readonly archive: Pick<ArchiveManager, "writeSnapshot">;
  readonly store: TransactionalStore;
  readonly sources: Pick<IntervalsSourceRepository, "recordArtifact" | "recordGenericLanding">;
  readonly runExclusive: <T>(work: () => Promise<T>) => Promise<T>;
  readonly now: () => number;
}

export interface ProviderActivityIntervalsArchiveRequest {
  readonly sourceRevision: string;
  readonly response: ActivityIntervals;
  readonly signal: AbortSignal;
}

export interface ProviderActivityIntervalsArchive {
  write(input: ProviderActivityIntervalsArchiveRequest): Promise<void>;
}

export interface ProviderActivityBestEffortsArchiveRequest {
  readonly sourceRevision: string;
  readonly durationSeconds: number;
  readonly response: BestEfforts;
  readonly signal: AbortSignal;
}

export interface ProviderActivityBestEffortsArchive {
  write(input: ProviderActivityBestEffortsArchiveRequest): Promise<void>;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function publishEvidence(input: {
  readonly dependencies: ProviderActivityAnalysisArchiveDependencies;
  readonly sourceRevision: string;
  readonly externalPrefix: string;
  readonly snapshot: unknown;
  readonly landing: unknown;
  readonly signal: AbortSignal;
}): Promise<void> {
  input.signal.throwIfAborted();
  const epochMilliseconds = input.dependencies.now();
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) {
    throw new TypeError("activity analysis archive clock is invalid");
  }
  const epochSeconds = Math.floor(epochMilliseconds / 1_000);
  const archived = await input.dependencies.archive.writeSnapshot(input.snapshot, { epochSeconds });
  input.signal.throwIfAborted();
  const externalId = `${input.externalPrefix}:analysis:${input.sourceRevision}:${archived.address}`;
  const landing = canonicalJson(input.landing);
  await input.dependencies.runExclusive(() =>
    input.dependencies.store.transaction(async () => {
      const artifact = await input.dependencies.sources.recordArtifact({
        source: "intervals-icu",
        lane: "streams",
        externalId,
        artifactKind: "snapshot",
        archiveAddress: archived.address,
        archiveRelPath: archived.relPath,
        archiveEpochSeconds: epochSeconds,
      });
      await input.dependencies.sources.recordGenericLanding({
        externalId,
        artifactKey: artifact.artifactKey,
        archiveAddress: archived.address,
        endpoint: "streams",
        normalizedPayloadJson: landing,
      });
    }),
  );
  input.signal.throwIfAborted();
}

export function createProviderActivityStreamArchive(
  input: ProviderActivityAnalysisArchiveDependencies,
): ProviderActivityStreamArchive {
  return Object.freeze({
    async write(request: ProviderActivityStreamArchiveRequest) {
      const snapshot = cloneJson({
        schema_version: 1,
        source_revision: request.sourceRevision,
        descriptors: request.descriptors,
      }) as {
        readonly schema_version: 1;
        readonly source_revision: string;
        readonly descriptors: readonly {
          readonly type: string;
          readonly data: readonly unknown[];
        }[];
      };
      await publishEvidence({
        dependencies: input,
        sourceRevision: request.sourceRevision,
        externalPrefix: "streams",
        snapshot,
        landing: {
          descriptor_count: snapshot.descriptors.length,
          sample_counts: snapshot.descriptors.map((descriptor) => descriptor.data.length),
          schema_version: 1,
          source_revision: request.sourceRevision,
          types: snapshot.descriptors.map((descriptor) => descriptor.type),
        },
        signal: request.signal,
      });
    },
  });
}

export function createProviderActivityIntervalsArchive(
  input: ProviderActivityAnalysisArchiveDependencies,
): ProviderActivityIntervalsArchive {
  return Object.freeze({
    async write(request: ProviderActivityIntervalsArchiveRequest) {
      const response = cloneJson(request.response);
      await publishEvidence({
        dependencies: input,
        sourceRevision: request.sourceRevision,
        externalPrefix: "intervals",
        snapshot: {
          schema_version: 1,
          source_revision: request.sourceRevision,
          response,
        },
        landing: {
          group_count: response.icuGroups?.length ?? 0,
          interval_count: response.icuIntervals?.length ?? 0,
          schema_version: 1,
          source_revision: request.sourceRevision,
        },
        signal: request.signal,
      });
    },
  });
}

export function createProviderActivityBestEffortsArchive(
  input: ProviderActivityAnalysisArchiveDependencies,
): ProviderActivityBestEffortsArchive {
  return Object.freeze({
    async write(request: ProviderActivityBestEffortsArchiveRequest) {
      const response = cloneJson(request.response);
      await publishEvidence({
        dependencies: input,
        sourceRevision: request.sourceRevision,
        externalPrefix: `best-efforts-${request.durationSeconds}`,
        snapshot: {
          schema_version: 1,
          source_revision: request.sourceRevision,
          duration_seconds: request.durationSeconds,
          response,
        },
        landing: {
          duration_seconds: request.durationSeconds,
          effort_count: response.efforts.length,
          schema_version: 1,
          source_revision: request.sourceRevision,
        },
        signal: request.signal,
      });
    },
  });
}
