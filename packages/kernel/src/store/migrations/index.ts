import init001 from "./001_init.sql";

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
];
