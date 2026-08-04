import init001 from "./001_init.sql";
import sql from "./002_repair_log.sql";
import dedup003 from "./003_dedup_confirmation.sql";
import fixerSettings004 from "./004_repair_fixer_settings.sql";
import syncState005 from "./005_sync_state.sql";
import incremental006 from "./006_incremental_ingest.sql";
import syncFailure007 from "./007_sync_failure.sql";
import storeOwner008 from "./008_store_owner.sql";

export interface Migration {
  /** Ascending schema version this migration advances the store to. */
  readonly version: number;
  /** The migration file's stem (diagnostics only). */
  readonly name: string;
  /** The DDL text, bundled as a string at build time. */
  readonly sql: string;
}

/**
 * Ordered numbered migrations, ascending by version. The migrator applies each
 * whose version exceeds the store's PRAGMA user_version, in order.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "001_init", sql: init001 },
  { version: 2, name: "002_repair_log", sql },
  { version: 3, name: "003_dedup_confirmation", sql: dedup003 },
  { version: 4, name: "004_repair_fixer_settings", sql: fixerSettings004 },
  { version: 5, name: "005_sync_state", sql: syncState005 },
  { version: 6, name: "006_incremental_ingest", sql: incremental006 },
  { version: 7, name: "007_sync_failure", sql: syncFailure007 },
  { version: 8, name: "008_store_owner", sql: storeOwner008 },
];
