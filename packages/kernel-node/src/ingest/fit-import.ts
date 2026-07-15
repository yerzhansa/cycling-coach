import { toHex, type ArchiveManager } from "@enduragent/kernel/archive";
import {
  FitSourceError,
  mapFitArtifact,
  rebuildRawFileInTransaction,
  withArchivePath,
  type FitSourceErrorCode,
} from "@enduragent/kernel/ingest";
import type { CryptoPort } from "@enduragent/kernel/ports";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { FitDecoder } from "./fit-decoder.js";

export interface FitImportDependencies {
  readonly archive: ArchiveManager;
  readonly crypto: CryptoPort;
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly decoder: FitDecoder;
}
export interface ImportedFitResult {
  readonly kind: "imported";
  readonly rawInserted: boolean;
  readonly rawSha256: string;
  readonly archivePath: string;
  readonly archiveDeduped: boolean;
}
export interface QuarantinedFitResult {
  readonly kind: "quarantined";
  readonly rawSha256: string;
  readonly archivePath: string;
  readonly reason: `fit:${FitSourceErrorCode}`;
}
export type FitImportResult = ImportedFitResult | QuarantinedFitResult;

export async function importFitArtifact(bytes: Uint8Array, dependencies: FitImportDependencies): Promise<FitImportResult> {
  const rawSha256 = toHex(await dependencies.crypto.sha256(bytes));
  let mapped;
  try {
    const decoded = await dependencies.decoder.decode(bytes);
    mapped = await mapFitArtifact({crypto:dependencies.crypto,rawSha256,rawByteLength:bytes.byteLength,archivePath:null,decoded});
  } catch (error) {
    if (!(error instanceof FitSourceError)) throw error;
    const reason = `fit:${error.code}` as const;
    const quarantined = await dependencies.archive.quarantine(bytes,"fit",reason);
    return {kind:"quarantined",rawSha256,archivePath:quarantined.relPath,reason};
  }
  const archived = await dependencies.archive.writeArtifact(bytes,"fit",{epochSeconds:mapped.logicalArchiveEpochSeconds});
  if (archived.address !== rawSha256) throw new Error("archive address mismatch");
  const artifact = withArchivePath(mapped,archived.relPath);
  const {rawInserted} = await dependencies.store.transaction(() => rebuildRawFileInTransaction(dependencies.store,artifact));
  return {kind:"imported",rawInserted,rawSha256,archivePath:archived.relPath,archiveDeduped:archived.deduped};
}
