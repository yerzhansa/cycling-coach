import type { CryptoPort, FileSystemPort } from "@enduragent/kernel/ports";
import {
  readSelectedGenericRows,
  readSelectedSourceRows,
  readSourceArtifactRows,
} from "@enduragent/kernel/ingest";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import {
  KEEP_ALL_ACTIVITIES,
  type ActivityProjectionFilter,
  type LocalBundleProducer,
  type ProducedLocalBundle,
  type VerifiedSnapshotReader,
} from "@enduragent/kernel/reference/local-bundle";
import type { SqlReadStore } from "@enduragent/kernel/store";
import { createVerifiedSnapshotReader } from "@enduragent/kernel-node/archive";
import { nodeFileSystem } from "@enduragent/kernel-node/filesystem";
import { createNodeCrypto } from "@enduragent/kernel-node/ingest";
import { openReadonlySqliteStorage } from "@enduragent/kernel-node/sqlite";
import { decodeLocalBundleProjection, type LocalBundleSelectedEvidence } from "@enduragent/sync-intervals-icu";

const SOURCE = "intervals-icu" as const;

export class LocalBundleProducerError extends Error {
  readonly code = "LOCAL_BUNDLE_PRODUCER_FAILED";
  readonly stages: readonly ("projection" | "close")[];
  constructor(stages: readonly ("projection" | "close")[]) {
    const message = stages.length === 2
      ? "local bundle projection failed; close also failed"
      : `local bundle ${stages[0]} failed`;
    super(message);
    this.name = "LocalBundleProducerError";
    this.stages = Object.freeze([...stages]);
    this.stack = `${this.name}: ${this.message}`;
    Object.freeze(this);
  }
}

export interface LocalBundleProducerOptions {
  readonly storePath: string;
  readonly archiveRoot: string;
  readonly activityFilter?: ActivityProjectionFilter;
}

export interface LocalBundleProducerDependencies {
  readonly openStore?: (path: string) => SqlReadStore;
  readonly createSnapshotReader?: (dependencies: {
    readonly archiveRoot: string;
    readonly crypto: CryptoPort;
    readonly fs: FileSystemPort;
  }) => VerifiedSnapshotReader;
  readonly fileSystem?: () => FileSystemPort;
  readonly crypto?: () => CryptoPort;
  readonly decode?: (
    manifest: ReferenceCaptureManifest,
    selected: LocalBundleSelectedEvidence,
    snapshots: VerifiedSnapshotReader,
    activityFilter: ActivityProjectionFilter,
  ) => Promise<ProducedLocalBundle["bundle"]>;
}

export function createLocalBundleProducer(
  options: LocalBundleProducerOptions,
  dependencies: LocalBundleProducerDependencies = {},
): LocalBundleProducer {
  const openStore = dependencies.openStore ?? openReadonlySqliteStorage;
  const makeSnapshots = dependencies.createSnapshotReader ?? createVerifiedSnapshotReader;
  const makeFileSystem = dependencies.fileSystem ?? nodeFileSystem;
  const makeCrypto = dependencies.crypto ?? createNodeCrypto;
  const decode = dependencies.decode ?? decodeLocalBundleProjection;
  const activityFilter = options.activityFilter ?? KEEP_ALL_ACTIVITIES;

  return Object.freeze({
    async produce(manifest: ReferenceCaptureManifest): Promise<ProducedLocalBundle> {
      let store: SqlReadStore | undefined;
      let produced: ProducedLocalBundle | undefined;
      let projectionFailed = false;
      try {
        store = openStore(options.storePath);
        const snapshots = makeSnapshots({ archiveRoot: options.archiveRoot, fs: makeFileSystem(), crypto: makeCrypto() });
        const selected: LocalBundleSelectedEvidence = {
          activities: await readSelectedSourceRows(store, { source: SOURCE, lane: "activities" }),
          settings: await readSelectedGenericRows(store, { source: SOURCE, lane: "settings" }),
          wellness: await readSourceArtifactRows(store, { source: SOURCE, lane: "wellness" }),
          streams: await readSelectedGenericRows(store, { source: SOURCE, lane: "streams" }),
        };
        const bundle = await decode(manifest, selected, snapshots, activityFilter);
        produced = { captureId: manifest.capture_id, frozenNow: manifest.plan.frozenNow, bundle };
      } catch {
        projectionFailed = true;
      }

      let closeFailed = false;
      if (store !== undefined) {
        try { await store.close(); } catch { closeFailed = true; }
      }
      if (projectionFailed || closeFailed) {
        const stages: ("projection" | "close")[] = [];
        if (projectionFailed) stages.push("projection");
        if (closeFailed) stages.push("close");
        throw new LocalBundleProducerError(stages);
      }
      return produced!;
    },
  });
}
