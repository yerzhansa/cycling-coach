import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../io/atomic-write-file-sync.js";
import {
  UNKNOWN_PROVENANCE,
  contentDigest,
  isSourceProvenance,
  type SourceProvenance,
} from "../provenance.js";

interface Entry {
  readonly digest: string;
  readonly provenance: SourceProvenance;
}

interface FileShape {
  readonly version: 1;
  readonly entries: Record<string, Entry>;
}

function isEntry(value: unknown): value is Entry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.digest === "string" && isSourceProvenance(entry.provenance);
}

export class ProvenanceMetadata {
  private readonly path: string;
  private cached?: FileShape;

  constructor(memoryDir: string) {
    this.path = join(memoryDir, ".source-provenance.json");
  }

  read(key: string, content: string): SourceProvenance {
    const entry: unknown = this.load().entries[key];
    if (!isEntry(entry) || entry.digest !== contentDigest(content)) {
      return UNKNOWN_PROVENANCE;
    }
    return entry.provenance;
  }

  matches(key: string, content: string): boolean {
    const entry: unknown = this.load().entries[key];
    return isEntry(entry) && entry.digest === contentDigest(content);
  }

  write(key: string, content: string, provenance: SourceProvenance): void {
    this.writeMany([{ key, content, provenance }]);
  }

  writeMany(
    entries: readonly {
      key: string;
      content: string;
      provenance: SourceProvenance;
    }[],
  ): void {
    this.replaceMany(entries, []);
  }

  replaceMany(
    entries: readonly {
      key: string;
      content: string;
      provenance: SourceProvenance;
    }[],
    deletedKeys: readonly string[],
  ): void {
    const file = this.load();
    for (const key of deletedKeys) delete file.entries[key];
    for (const { key, content, provenance } of entries) {
      file.entries[key] = { digest: contentDigest(content), provenance };
    }
    atomicWriteFileSync(this.path, JSON.stringify(file, null, 2) + "\n");
  }

  private load(): FileShape {
    if (this.cached !== undefined) return this.cached;
    if (!existsSync(this.path)) {
      this.cached = { version: 1, entries: {} };
      return this.cached;
    }
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        this.cached = { version: 1, entries: {} };
        return this.cached;
      }
      const record = value as { version?: unknown; entries?: unknown };
      if (record.version !== 1) {
        this.cached = { version: 1, entries: {} };
        return this.cached;
      }
      const entries = record.entries;
      if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
        this.cached = { version: 1, entries: {} };
        return this.cached;
      }
      const validEntries: Record<string, Entry> = Object.create(null) as Record<string, Entry>;
      for (const [key, entry] of Object.entries(entries)) {
        if (isEntry(entry)) validEntries[key] = entry;
      }
      this.cached = { version: 1, entries: validEntries };
      return this.cached;
    } catch {
      this.cached = { version: 1, entries: {} };
      return this.cached;
    }
  }
}
