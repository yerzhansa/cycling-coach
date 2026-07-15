import { toHex, type ArchiveManager } from "@enduragent/kernel/archive";
import {
  FIT_INGEST_VERSION,
  deleteAllDerivedRowsInTransaction,
  rebuildRawFileInTransaction,
  type MappedFitArtifact,
} from "@enduragent/kernel/ingest";
import type { CryptoPort } from "@enduragent/kernel/ports";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";

export interface ArchivedRawArtifact {
  readonly rawSha256: string;
  readonly archivePath: string;
  readonly format: "fit" | "tcx" | "gpx";
  readonly bytes: Uint8Array;
}

export type ReconstructedArtifact = MappedFitArtifact | null;

export interface EnsureCurrentIngestVersionDependencies {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly archive: Pick<ArchiveManager, "readArtifact">;
  readonly crypto: CryptoPort;
  readonly reconstructArchivedArtifact: (
    artifact: ArchivedRawArtifact,
  ) => Promise<ReconstructedArtifact>;
}

export type EnsureCurrentIngestVersionResult =
  | { readonly rebuilt: false; readonly from: 1; readonly to: 1 }
  | { readonly rebuilt: true; readonly from: 0; readonly to: 1 };

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid ${name}`);
  return value;
}

export async function ensureCurrentIngestVersion(
  dependencies: EnsureCurrentIngestVersionDependencies,
): Promise<EnsureCurrentIngestVersionResult> {
  const rows = await dependencies.store.all("SELECT ingest_version FROM ingest_metadata WHERE singleton=1");
  if (rows.length !== 1) throw new Error("ingest metadata invariant mismatch");
  const from = integer(rows[0]!.ingest_version, "ingest version");
  if (from === FIT_INGEST_VERSION) return { rebuilt: false, from: 1, to: 1 };
  if (from > FIT_INGEST_VERSION) throw new Error("store uses newer ingest semantics");
  if (from !== 0) throw new Error("unsupported ingest version");

  const inventoryRows = await dependencies.store.all(`SELECT sha256, path, ext, bytes
FROM raw_file
ORDER BY sha256 ASC`);
  const archived: ArchivedRawArtifact[] = [];
  for (const row of inventoryRows) {
    const rawSha256 = row.sha256;
    const archivePath = row.path;
    const format = row.ext;
    const byteCount = integer(row.bytes, "raw byte count");
    if (typeof rawSha256 !== "string" || !/^[0-9a-f]{64}$/.test(rawSha256)) throw new TypeError("invalid raw SHA");
    if (typeof archivePath !== "string" || archivePath.length === 0) throw new TypeError("invalid archive path");
    if (format !== "fit" && format !== "tcx" && format !== "gpx") throw new TypeError("invalid archive format");
    const bytes = new Uint8Array(await dependencies.archive.readArtifact(archivePath));
    if (bytes.byteLength !== byteCount) throw new Error("archive byte count mismatch");
    if (toHex(await dependencies.crypto.sha256(bytes)) !== rawSha256) throw new Error("archive SHA mismatch");
    archived.push({ rawSha256, archivePath, format, bytes: new Uint8Array(bytes) });
  }

  const reconstructed: MappedFitArtifact[] = [];
  for (const artifact of archived) {
    const mapped = await dependencies.reconstructArchivedArtifact({ ...artifact, bytes: new Uint8Array(artifact.bytes) });
    if (mapped === null) continue;
    if (mapped.rawFile.sha256 !== artifact.rawSha256
      || mapped.rawFile.path !== artifact.archivePath
      || mapped.rawFile.bytes !== artifact.bytes.byteLength) {
      throw new Error("reconstructed artifact identity mismatch");
    }
    reconstructed.push(mapped);
  }

  const rebuilt = await dependencies.store.transaction(async () => {
    const currentRows = await dependencies.store.all(
      "SELECT ingest_version FROM ingest_metadata WHERE singleton=1",
    );
    if (currentRows.length !== 1) throw new Error("ingest metadata invariant mismatch");
    const current = integer(currentRows[0]!.ingest_version, "ingest version");
    if (current === FIT_INGEST_VERSION) return false;
    if (current !== from) throw new Error("ingest version changed during rebuild preparation");
    await deleteAllDerivedRowsInTransaction(dependencies.store);
    for (const artifact of reconstructed) {
      await rebuildRawFileInTransaction(dependencies.store, artifact, dependencies.crypto);
    }
    await dependencies.store.run("UPDATE ingest_metadata SET ingest_version = 1 WHERE singleton = 1");
    const finalRows = await dependencies.store.all("SELECT singleton, ingest_version FROM ingest_metadata WHERE singleton=1");
    if (finalRows.length !== 1 || finalRows[0]!.singleton !== 1 || finalRows[0]!.ingest_version !== 1) {
      throw new Error("ingest metadata update failed");
    }
    return true;
  });
  return rebuilt
    ? { rebuilt: true, from: 0, to: 1 }
    : { rebuilt: false, from: 1, to: 1 };
}
