import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { open, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CryptoPort, FileSystemPort } from "@enduragent/kernel/ports";
import { canonicalJson } from "@enduragent/kernel/archive";
import { createArchiveManager } from "../src/archive/index.js";

function makeCrypto(): CryptoPort {
  return {
    async sha256(data) {
      return new Uint8Array(createHash("sha256").update(data).digest());
    },
    async randomBytes(length) {
      return new Uint8Array(randomBytes(length));
    },
    async pbkdf2() {
      throw new Error("unused in archive tests");
    },
    async aesGcmEncrypt() {
      throw new Error("unused in archive tests");
    },
    async aesGcmDecrypt() {
      throw new Error("unused in archive tests");
    },
  };
}

function makeFs(): FileSystemPort {
  return {
    async readFile(path) {
      return new Uint8Array(await readFile(path));
    },
    async readTextFile(path) {
      return readFile(path, "utf8");
    },
    async writeFile(path, data, options) {
      const tmp = `${path}.tmp.${randomBytes(4).toString("hex")}`;
      const fh = await open(tmp, "w", options?.mode ?? 0o600);
      try {
        await fh.writeFile(typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data));
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, path);
    },
    async rename(from, to) {
      await rename(from, to);
    },
    async mkdir(path, options) {
      await mkdir(path, { recursive: options?.recursive ?? false });
    },
    async list() {
      throw new Error("unused in archive tests");
    },
    async stat(path) {
      try {
        const s = await stat(path);
        return {
          kind: s.isFile() ? "file" : s.isDirectory() ? "directory" : "other",
          size: s.size,
          mtimeMs: s.mtimeMs,
        };
      } catch {
        return undefined;
      }
    },
  };
}

const WHEN = { epochSeconds: 1615766400 }; // 2021-03-15T00:00:00Z

let archiveRoot: string;

beforeEach(() => {
  archiveRoot = mkdtempSync(join(tmpdir(), "archive-mgr-"));
});

afterEach(() => {
  rmSync(archiveRoot, { recursive: true, force: true });
});

function makeManager() {
  return createArchiveManager({ archiveRoot, crypto: makeCrypto(), fs: makeFs() });
}

describe("archive manager", () => {
  it("produces a stable content address for identical bytes", async () => {
    const manager = makeManager();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const first = await manager.writeArtifact(bytes, "fit", WHEN);
    const second = await manager.writeArtifact(new Uint8Array([1, 2, 3, 4]), "fit", WHEN);
    expect(first.address).toBe(second.address);
    expect(first.relPath).toBe(second.relPath);
    expect(first.relPath).toBe(`2021/03/${first.address}.fit`);
  });

  it("is idempotent — the second write is a skipped no-op, not a rewrite", async () => {
    const manager = makeManager();
    const bytes = new Uint8Array([9, 8, 7]);
    const first = await manager.writeArtifact(bytes, "fit", WHEN);
    expect(first.deduped).toBe(false);

    const full = join(archiveRoot, first.relPath);
    // Overwrite the committed file with a sentinel; a dedup no-op must leave it.
    await writeFile(full, Buffer.from([42]));

    const second = await manager.writeArtifact(bytes, "fit", WHEN);
    expect(second.deduped).toBe(true);
    expect(new Uint8Array(await readFile(full))).toEqual(new Uint8Array([42]));
  });

  it("routes unparseable bytes to quarantine with a durable reason sidecar", async () => {
    const manager = makeManager();
    const bytes = new Uint8Array([255, 0, 128]);
    const result = await manager.quarantine(bytes, "bin", "unparseable payload");

    expect(result.relPath).toBe(`quarantine/${result.address}.bin`);
    const full = join(archiveRoot, result.relPath);
    expect(new Uint8Array(await readFile(full))).toEqual(bytes);
    expect(await readFile(`${full}.reason.txt`, "utf8")).toBe("unparseable payload");

    // Nothing landed under a yyyy/mm shard.
    const yearDirs = readdirSync(archiveRoot).filter((name) => /^\d{4}$/.test(name));
    expect(yearDirs).toEqual([]);
  });

  it("round-trips a snapshot through gzip and canonical JSON", async () => {
    const manager = makeManager();
    const payload = { b: 1, a: { d: 4, c: 3 }, list: [3, 1, 2] };
    const result = await manager.writeSnapshot(payload, WHEN);

    expect(result.relPath.endsWith(".json.gz")).toBe(true);
    const readBack = await manager.readSnapshot(result.relPath);
    expect(canonicalJson(readBack)).toBe(canonicalJson(payload));
  });

  it("addresses the compressed bytes and dedups a repeated snapshot", async () => {
    const manager = makeManager();
    const payload = { alpha: [1, 2, 3], beta: "x" };
    const first = await manager.writeSnapshot(payload, WHEN);
    const second = await manager.writeSnapshot(payload, WHEN);
    expect(first.address).toBe(second.address);
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
  });

  it("exposes no deletion or mutation surface (never-delete is structural)", () => {
    const manager = makeManager();
    for (const forbidden of ["delete", "remove", "unlink", "prune", "update", "rm"]) {
      expect(forbidden in manager).toBe(false);
    }
  });

  it("confines every written path under archiveRoot", async () => {
    const manager = makeManager();
    const artifact = await manager.writeArtifact(new Uint8Array([1]), "fit", WHEN);
    const snapshot = await manager.writeSnapshot({ k: 1 }, WHEN);
    const quarantined = await manager.quarantine(new Uint8Array([2]), "bin", "why");
    const rootReal = resolve(archiveRoot);
    for (const rel of [artifact.relPath, snapshot.relPath, quarantined.relPath]) {
      const full = resolve(join(archiveRoot, rel));
      const rel2 = relative(rootReal, full);
      expect(rel2.startsWith("..")).toBe(false);
      expect(isAbsolute(rel2)).toBe(false);
    }
  });
});
