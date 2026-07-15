import { createActivityRepository } from "../store/activity-repository.js";
import { DERIVED_TABLES } from "../store/dump.js";
import type { MigratorStore } from "../store/migrator.js";
import type { SqlStore } from "../store/ports.js";
import { createRawFileRepository } from "../store/source-repository.js";
import type { MappedFitArtifact } from "./types.js";

export async function rebuildRawFileInTransaction(store: SqlStore, artifact: MappedFitArtifact): Promise<{ rawInserted: boolean }> {
  const rawInserted = await createRawFileRepository(store).upsert(artifact.rawFile);
  await createActivityRepository(store).replaceForRawFile(artifact.rawFile.sha256, artifact.activity);
  return { rawInserted };
}

export async function rebuildRawFile(store: SqlStore & Pick<MigratorStore, "transaction">, artifact: MappedFitArtifact): Promise<{ rawInserted: boolean }> {
  return store.transaction(() => rebuildRawFileInTransaction(store, artifact));
}

export async function deleteAllDerivedRowsInTransaction(store: SqlStore): Promise<void> {
  for (const table of DERIVED_TABLES) await store.exec(`DELETE FROM ${table}`);
}
