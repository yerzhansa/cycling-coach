import { canonicalJson, type ArchiveManager } from "@enduragent/kernel/archive";
import type { IntervalsSourceRepository, SqlStore } from "@enduragent/kernel/store";
import type {
  ProviderActivityStreamArchive,
  ProviderActivityStreamArchiveRequest,
} from "./activity-analysis-provider.js";

interface TransactionalStore extends SqlStore {
  transaction<T>(work: () => Promise<T>): Promise<T>;
}

export function createProviderActivityStreamArchive(input: {
  readonly archive: Pick<ArchiveManager, "writeSnapshot">;
  readonly store: TransactionalStore;
  readonly sources: Pick<IntervalsSourceRepository, "recordArtifact" | "recordGenericLanding">;
  readonly runExclusive: <T>(work: () => Promise<T>) => Promise<T>;
  readonly now: () => number;
}): ProviderActivityStreamArchive {
  return Object.freeze({
    async write(request: ProviderActivityStreamArchiveRequest) {
      request.signal.throwIfAborted();
      const snapshot = JSON.parse(
        JSON.stringify({
          schema_version: 1,
          source_revision: request.sourceRevision,
          descriptors: request.descriptors,
        }),
      ) as {
        readonly schema_version: 1;
        readonly source_revision: string;
        readonly descriptors: readonly {
          readonly type: string;
          readonly data: readonly unknown[];
        }[];
      };
      const epochMilliseconds = input.now();
      if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) {
        throw new TypeError("activity analysis archive clock is invalid");
      }
      const epochSeconds = Math.floor(epochMilliseconds / 1_000);
      const archived = await input.archive.writeSnapshot(snapshot, { epochSeconds });
      request.signal.throwIfAborted();
      const externalId = `streams:analysis:${request.sourceRevision}:${archived.address}`;
      const landing = canonicalJson({
        descriptor_count: snapshot.descriptors.length,
        sample_counts: snapshot.descriptors.map((descriptor) => descriptor.data.length),
        schema_version: 1,
        source_revision: request.sourceRevision,
        types: snapshot.descriptors.map((descriptor) => descriptor.type),
      });
      await input.runExclusive(() =>
        input.store.transaction(async () => {
          const artifact = await input.sources.recordArtifact({
            source: "intervals-icu",
            lane: "streams",
            externalId,
            artifactKind: "snapshot",
            archiveAddress: archived.address,
            archiveRelPath: archived.relPath,
            archiveEpochSeconds: epochSeconds,
          });
          await input.sources.recordGenericLanding({
            externalId,
            artifactKey: artifact.artifactKey,
            archiveAddress: archived.address,
            endpoint: "streams",
            normalizedPayloadJson: landing,
          });
        }),
      );
      request.signal.throwIfAborted();
    },
  });
}
