import {
  appendFileSync,
  closeSync,
  existsSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
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

interface PutRecord extends Entry {
  readonly version: 1;
  readonly op: "put";
  readonly key: string;
}

interface DeleteRecord {
  readonly version: 1;
  readonly op: "delete";
  readonly key: string;
}

type JournalRecord = PutRecord | DeleteRecord;

function parseRecord(value: unknown): JournalRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.key !== "string") return undefined;
  if (record.op === "delete") return { version: 1, op: "delete", key: record.key };
  if (
    record.op === "put" &&
    typeof record.digest === "string" &&
    isSourceProvenance(record.provenance)
  ) {
    return {
      version: 1,
      op: "put",
      key: record.key,
      digest: record.digest,
      provenance: record.provenance,
    };
  }
  return undefined;
}

export class ProvenanceMetadata {
  private readonly directoryPath: string;
  private readonly path: string;
  private cached?: Map<string, Entry>;
  private directorySynced = false;

  constructor(memoryDir: string) {
    this.directoryPath = memoryDir;
    this.path = join(memoryDir, ".source-provenance.jsonl");
  }

  read(key: string, content: string): SourceProvenance {
    const entry = this.load().get(key);
    if (entry === undefined || entry.digest !== contentDigest(content)) {
      return UNKNOWN_PROVENANCE;
    }
    return entry.provenance;
  }

  matches(key: string, content: string): boolean {
    return this.load().get(key)?.digest === contentDigest(content);
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
    const records: JournalRecord[] = [
      ...deletedKeys.map((key): DeleteRecord => ({ version: 1, op: "delete", key })),
      ...entries.map(
        ({ key, content, provenance }): PutRecord => ({
          version: 1,
          op: "put",
          key,
          digest: contentDigest(content),
          provenance,
        }),
      ),
    ];
    if (records.length === 0) return;

    const serialized = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    const fd = openSync(this.path, "a+", 0o600);
    try {
      const size = fstatSync(fd).size;
      const lastByte = Buffer.allocUnsafe(1);
      const boundary =
        size > 0 && readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 0x0a
          ? "\n"
          : "";
      appendFileSync(fd, boundary + serialized, { encoding: "utf8" });
      fdatasyncSync(fd);
      if (!this.directorySynced) {
        const directoryFd = openSync(this.directoryPath, "r");
        try {
          fsyncSync(directoryFd);
          this.directorySynced = true;
        } finally {
          closeSync(directoryFd);
        }
      }
    } finally {
      closeSync(fd);
    }

    const cache = this.load();
    for (const record of records) {
      if (record.op === "delete") cache.delete(record.key);
      else cache.set(record.key, { digest: record.digest, provenance: record.provenance });
    }
  }

  private load(): Map<string, Entry> {
    if (this.cached !== undefined) return this.cached;
    const entries = new Map<string, Entry>();
    if (!existsSync(this.path)) {
      this.cached = entries;
      return entries;
    }
    try {
      for (const line of readFileSync(this.path, "utf8").split("\n")) {
        if (line === "") continue;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          continue;
        }
        const record = parseRecord(value);
        if (record === undefined) continue;
        if (record.op === "delete") entries.delete(record.key);
        else entries.set(record.key, { digest: record.digest, provenance: record.provenance });
      }
    } catch {
      entries.clear();
    }
    this.cached = entries;
    return entries;
  }
}
