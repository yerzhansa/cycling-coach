export type StorageParam = string | number | bigint | Uint8Array | null;

export type StorageValue = string | number | bigint | Uint8Array | null;

export type StorageRow = Readonly<Record<string, StorageValue>>;

export interface StorageRunResult {
  readonly changes: number | bigint;
  readonly lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(...params: readonly StorageParam[]): Promise<StorageRunResult>;
  get(...params: readonly StorageParam[]): Promise<StorageRow | undefined>;
  all(...params: readonly StorageParam[]): Promise<readonly StorageRow[]>;
}

// SQL driver seam for an already-open connection. Opening (which needs a
// filesystem path) is a host concern and is deliberately not on this port.
export interface StoragePort {
  exec(sql: string): Promise<void>;
  prepare(sql: string): Promise<PreparedStatement>;
  pragma(source: string): Promise<StorageValue>;
  close(): Promise<void>;
}
