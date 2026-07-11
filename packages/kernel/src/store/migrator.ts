export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export interface MigratorStore {
  getUserVersion(): Promise<number>;
  setUserVersion(version: number): Promise<void>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

export interface MigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly applied: readonly number[];
}

export class StoreNewerThanAppError extends Error {
  readonly storeVersion: number;
  readonly appMaxVersion: number;
  constructor(storeVersion: number, appMaxVersion: number) {
    super("store is newer than this app");
    this.name = "StoreNewerThanAppError";
    this.storeVersion = storeVersion;
    this.appMaxVersion = appMaxVersion;
  }
}

export class InvalidMigrationSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMigrationSetError";
  }
}

function validateAndSort(migrations: readonly Migration[]): Migration[] {
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new InvalidMigrationSetError(
        `migration version must be a positive integer, got ${String(m.version)}`,
      );
    }
    if (seen.has(m.version)) {
      throw new InvalidMigrationSetError(`duplicate migration version ${m.version}`);
    }
    seen.add(m.version);
  }
  return [...migrations].sort((a, b) => a.version - b.version);
}

// Startup order is acquire-lock -> migrate -> open store RW; the lock is a
// separate concern. A thrown StoreNewerThanAppError must abort startup before
// any read-write use of the store.
export async function runMigrations(
  store: MigratorStore,
  migrations: readonly Migration[],
): Promise<MigrationResult> {
  const sorted = validateAndSort(migrations);
  const appMaxVersion = sorted.length === 0 ? 0 : sorted[sorted.length - 1]!.version;

  const current = await store.getUserVersion();
  if (current > appMaxVersion) {
    throw new StoreNewerThanAppError(current, appMaxVersion);
  }

  // Connection/store state, set outside any transaction (SQLite ignores these
  // PRAGMAs inside a transaction). Ordered AFTER the downgrade refusal so a
  // newer store is never written (journal_mode=WAL mutates the DB header).
  await store.exec("PRAGMA journal_mode = WAL");
  await store.exec("PRAGMA foreign_keys = ON");

  const pending = sorted.filter((m) => m.version > current);
  const applied: number[] = [];
  for (const m of pending) {
    await store.transaction(async () => {
      await store.exec(m.sql);
      await store.setUserVersion(m.version);
    });
    applied.push(m.version);
  }

  return { fromVersion: current, toVersion: appMaxVersion, applied };
}
