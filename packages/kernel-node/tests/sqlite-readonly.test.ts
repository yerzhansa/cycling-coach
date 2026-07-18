import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, toHex } from "@enduragent/kernel/archive";
import type { FileSystemPort } from "@enduragent/kernel/ports";
import { createVerifiedSnapshotReader } from "../src/archive/manager.js";
import { nodeFileSystem } from "../src/filesystem/index.js";
import { createNodeCrypto } from "../src/ingest/import-files.js";
import { openReadonlySqliteStorage } from "../src/sqlite/database.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const { rm } = await import("node:fs/promises");
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reference-readonly-"));
  directories.push(directory);
  return directory;
}

describe("read-only SQLite storage", () => {
  it("opens an existing database read-only and exposes no mutator", async () => {
    const directory = await temporary();
    const path = join(directory, "store.sqlite");
    const writable = new DatabaseSync(path);
    writable.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('synthetic');");
    writable.close();

    const store = openReadonlySqliteStorage(path);
    expect(await store.get("SELECT value FROM sample")).toEqual({ value: "synthetic" });
    expect(await store.all("SELECT value FROM sample")).toEqual([{ value: "synthetic" }]);
    expect(store).not.toHaveProperty("run");
    expect(store).not.toHaveProperty("exec");
    await expect(store.get("INSERT INTO sample VALUES (?) RETURNING value", ["changed"])).rejects.toThrow();
    await store.close();

    const verify = new DatabaseSync(path, { readOnly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM sample").get()).toEqual({ count: 1 });
    verify.close();
  });

  it("does not create a missing database", async () => {
    const directory = await temporary();
    const path = join(directory, "absent.sqlite");
    expect(() => openReadonlySqliteStorage(path)).toThrow();
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("verified snapshot reader", () => {
  it("authenticates the exact compressed bytes before decoding", async () => {
    const directory = await temporary();
    const crypto = createNodeCrypto();
    const compressed = new Uint8Array(gzipSync(Buffer.from(canonicalJson({ id: "1998-06-04" }), "utf8")));
    const address = toHex(await crypto.sha256(compressed));
    const relPath = `1998/06/${address}.json.gz`;
    const full = join(directory, relPath);
    await nodeFileSystem().mkdir(join(directory, "1998/06"), { recursive: true });
    await writeFile(full, compressed);
    const reader = createVerifiedSnapshotReader({ archiveRoot: directory, crypto, fs: nodeFileSystem() });
    await expect(reader.readVerifiedSnapshot({ address, rel_path: relPath })).resolves.toEqual({ id: "1998-06-04" });
    expect(new Uint8Array(await readFile(full))).toEqual(compressed);
  });

  it("rejects same-date tampering by compressed-byte address", async () => {
    const directory = await temporary();
    const crypto = createNodeCrypto();
    const expected = new Uint8Array(gzipSync(Buffer.from(canonicalJson({ value: 1 }), "utf8")));
    const tampered = new Uint8Array(gzipSync(Buffer.from(canonicalJson({ value: 2 }), "utf8")));
    const address = toHex(await crypto.sha256(expected));
    const relPath = `1998/06/${address}.json.gz`;
    await nodeFileSystem().mkdir(join(directory, "1998/06"), { recursive: true });
    await writeFile(join(directory, relPath), tampered);
    const reader = createVerifiedSnapshotReader({ archiveRoot: directory, crypto, fs: nodeFileSystem() });
    await expect(reader.readVerifiedSnapshot({ address, rel_path: relPath }))
      .rejects.toThrowError(new TypeError("archive snapshot address mismatch"));
  });

  it("uses fixed read and decode errors", async () => {
    const crypto = createNodeCrypto();
    const failedFs = { readFile: async () => { throw new Error("private sentinel"); } } as unknown as FileSystemPort;
    const failed = createVerifiedSnapshotReader({ archiveRoot: "/synthetic", crypto, fs: failedFs });
    await expect(failed.readVerifiedSnapshot({ address: "0".repeat(64), rel_path: `1998/06/${"0".repeat(64)}.json.gz` }))
      .rejects.toThrowError(new TypeError("archive snapshot read failed"));

    const invalid = new Uint8Array([1, 2, 3]);
    const address = toHex(await crypto.sha256(invalid));
    const invalidFs = { readFile: async () => invalid } as unknown as FileSystemPort;
    const reader = createVerifiedSnapshotReader({ archiveRoot: "/synthetic", crypto, fs: invalidFs });
    await expect(reader.readVerifiedSnapshot({ address, rel_path: `1998/06/${address}.json.gz` }))
      .rejects.toThrowError(new TypeError("archive snapshot is invalid"));
  });
});
