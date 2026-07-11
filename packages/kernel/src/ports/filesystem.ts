export interface DirEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
}

export interface FileStat {
  readonly kind: "file" | "directory" | "other";
  readonly size: number;
  readonly mtimeMs: number;
}

export interface WriteFileOptions {
  readonly mode?: number;
}

export interface FileSystemPort {
  readFile(path: string): Promise<Uint8Array>;
  readTextFile(path: string): Promise<string>;
  /** Atomic write: temp file (default mode 0o600) -> write -> fsync -> rename over the target path. */
  writeFile(path: string, data: Uint8Array | string, options?: WriteFileOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  list(path: string): Promise<readonly DirEntry[]>;
  /** Resolves undefined when the path does not exist. */
  stat(path: string): Promise<FileStat | undefined>;
}
