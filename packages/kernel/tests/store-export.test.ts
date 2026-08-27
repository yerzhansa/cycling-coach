import { describe, it, expect } from "vitest";
import {
  buildExport,
  importExport,
  decodeContainer,
  encodeContainer,
  EXPORT_WARNING,
  EXPORT_FORMAT_VERSION,
  CONTAINER_MAGIC,
  PBKDF2_ITERATIONS,
  ExportFormatError,
  ExportPassphraseRequiredError,
  ExportDecryptionError,
  ExportSchemaMismatchError,
  PURE_AUTHORED_TABLES,
  MIXED_AUTHORED_TABLES,
  type ExportCryptoPort,
  type TextCodec,
  type ArchiveArtifact,
  type AuthoredRow,
  type ExportSource,
  type ArchiveManifestReader,
  type ImportSink,
  type ArchivePresenceChecker,
  type RestoreTableResult,
} from "@enduragent/kernel/store/export";

const codec: TextCodec = {
  encodeUtf8: (s) => new TextEncoder().encode(s),
  decodeUtf8: (b) => new TextDecoder().decode(b),
};

function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

const TAG16 = new Uint8Array(16);

class FakeCrypto implements ExportCryptoPort {
  private readonly recorded = new Set<string>();
  private counter = 0;
  randomBytes(n: number): Uint8Array {
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = (this.counter + i) & 0xff;
    this.counter += 1;
    return b;
  }
  async encrypt(input: {
    passphrase: string;
    salt: Uint8Array;
    iterations: number;
    nonce: Uint8Array;
    aad: Uint8Array;
    plaintext: Uint8Array;
  }): Promise<Uint8Array> {
    this.recorded.add(`${input.passphrase}:${toHex(input.aad)}`);
    const out = new Uint8Array(input.plaintext.length + 16);
    out.set(input.plaintext, 0);
    out.set(TAG16, input.plaintext.length);
    return out;
  }
  async decrypt(input: {
    passphrase: string;
    salt: Uint8Array;
    iterations: number;
    nonce: Uint8Array;
    aad: Uint8Array;
    ciphertext: Uint8Array;
  }): Promise<Uint8Array> {
    if (!this.recorded.has(`${input.passphrase}:${toHex(input.aad)}`)) {
      throw new Error("auth failure");
    }
    return input.ciphertext.subarray(0, input.ciphertext.length - 16);
  }
}

interface Populated {
  readonly userVersion: number;
  readonly rows: Record<string, readonly AuthoredRow[]>;
  readonly artifacts: readonly ArchiveArtifact[];
}

function populated(userVersion = 3): Populated {
  const rows: Record<string, readonly AuthoredRow[]> = {};
  for (const t of PURE_AUTHORED_TABLES)
    rows[t] = [
      { id: `${t}-1`, v: 1 },
      { id: `${t}-2`, v: 2 },
    ];
  for (const t of MIXED_AUTHORED_TABLES) rows[t] = [{ id: `${t}-m1`, provenance: "manual" }];
  const artifacts: ArchiveArtifact[] = [
    { address: "cc", relPath: "archive/2026/06/cc/cc.fit", bytes: 10, kind: "fit" },
    { address: "aa", relPath: "archive/2026/06/aa/aa.fit", bytes: 20, kind: "fit" },
    { address: "bb", relPath: "archive/2026/06/bb/bb.tcx", bytes: 30, kind: "tcx" },
  ];
  return { userVersion, rows, artifacts };
}

interface SourceCall {
  table: string;
  manualOnly: boolean;
}

function makeSource(data: Populated): { source: ExportSource; calls: SourceCall[] } {
  const calls: SourceCall[] = [];
  const source: ExportSource = {
    async readUserVersion() {
      return data.userVersion;
    },
    async readAuthoredTable(table, opts) {
      calls.push({ table, manualOnly: opts.manualOnly });
      return data.rows[table] ?? [];
    },
  };
  return { source, calls };
}

function makeManifest(data: Populated): ArchiveManifestReader {
  return {
    async listArtifacts() {
      return data.artifacts;
    },
  };
}

function makeSink(): ImportSink & { stored: Map<string, Set<string>> } {
  const stored = new Map<string, Set<string>>();
  const sink: ImportSink & { stored: Map<string, Set<string>> } = {
    stored,
    async restoreAuthoredTable(table, rows): Promise<RestoreTableResult> {
      let set = stored.get(table);
      if (!set) {
        set = new Set<string>();
        stored.set(table, set);
      }
      let inserted = 0;
      let skipped = 0;
      for (const row of rows) {
        const key = JSON.stringify(row);
        if (set.has(key)) skipped += 1;
        else {
          set.add(key);
          inserted += 1;
        }
      }
      return { table, inserted, skipped };
    },
  };
  return sink;
}

function makePresence(
  missingAddresses: readonly string[] = [],
): ArchivePresenceChecker & { queried: string[] } {
  const missing = new Set(missingAddresses);
  const queried: string[] = [];
  const p: ArchivePresenceChecker & { queried: string[] } = {
    queried,
    async hasArtifact(address) {
      queried.push(address);
      return !missing.has(address);
    },
  };
  return p;
}

describe("store export op", () => {
  it("(enumerate) exports every authored key with correct manualOnly flags and no source/derived tables", async () => {
    const data = populated();
    const { source, calls } = makeSource(data);
    const crypto = new FakeCrypto();
    const result = await buildExport({ source, manifest: makeManifest(data), crypto, codec }, {});
    const document = (await decodeContainer(result.container, { codec, crypto }, {})) as {
      store: { authored: Record<string, unknown[]> };
    };
    const keys = Object.keys(document.store.authored).sort();
    const expected = [...PURE_AUTHORED_TABLES, ...MIXED_AUTHORED_TABLES].sort();
    expect(keys).toEqual(expected);
    for (const k of keys) expect(Array.isArray(document.store.authored[k])).toBe(true);
    for (const t of PURE_AUTHORED_TABLES) {
      expect(calls.find((c) => c.table === t)?.manualOnly).toBe(false);
    }
    for (const t of MIXED_AUTHORED_TABLES) {
      expect(calls.find((c) => c.table === t)?.manualOnly).toBe(true);
    }
    for (const forbidden of [
      "workout",
      "session",
      "stream",
      "raw_file",
      "source_record",
      "metric_snapshot",
      "lap",
      "swim_length",
      "mean_max_cache",
      "source_artifact",
      "source_record_revision",
      "source_record_current",
      "source_watermark",
      "sync_operation",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    const portableTables = [...PURE_AUTHORED_TABLES, ...MIXED_AUTHORED_TABLES];
    for (const excluded of [
      "source_artifact",
      "source_record_revision",
      "source_record_current",
      "source_watermark",
      "sync_operation",
    ]) {
      expect(portableTables).not.toContain(excluded);
      expect(calls.some(({ table }) => table === excluded)).toBe(false);
    }
  });

  it("(roundtrip-plain) plaintext round-trip restores every authored table", async () => {
    const data = populated();
    const { source } = makeSource(data);
    const crypto = new FakeCrypto();
    const built = await buildExport({ source, manifest: makeManifest(data), crypto, codec }, {});
    expect(built.warning).toBe(EXPORT_WARNING);
    expect(built.encrypted).toBe(false);
    expect(built.container[9]).toBe(0x00);
    const sink = makeSink();
    const imported = await importExport(
      { sink, presence: makePresence(), crypto, codec, targetUserVersion: 5 },
      { container: built.container },
    );
    expect(imported.restored).toHaveLength(
      PURE_AUTHORED_TABLES.length + MIXED_AUTHORED_TABLES.length,
    );
    expect(imported.restored.find((row) => row.table === "dedup_confirmation")?.inserted).toBe(2);
    for (const t of PURE_AUTHORED_TABLES) {
      expect(imported.restored.find((r) => r.table === t)?.inserted).toBe(2);
    }
    for (const t of MIXED_AUTHORED_TABLES) {
      expect(imported.restored.find((r) => r.table === t)?.inserted).toBe(1);
    }
    expect(imported.manifest.total).toBe(data.artifacts.length);
  });

  it("orders Draft revisions parent-first before restore", async () => {
    const data = populated();
    data.rows.plan_draft_revision = [
      { id: "child", revision: 2, parent_revision_id: "parent" },
      { id: "parent", revision: 1, parent_revision_id: null },
    ];
    const { source } = makeSource(data);
    const crypto = new FakeCrypto();
    const built = await buildExport({ source, manifest: makeManifest(data), crypto, codec }, {});
    const sink = makeSink();
    await importExport(
      { sink, presence: makePresence(), crypto, codec, targetUserVersion: 5 },
      { container: built.container },
    );
    const restored = [...(sink.stored.get("plan_draft_revision") ?? [])]
      .map((row) => JSON.parse(row) as { readonly revision: number });
    expect(restored.map(({ revision }) => revision)).toEqual([1, 2]);
  });

  it("(roundtrip-pass) passphrase container header + round-trip", async () => {
    const data = populated();
    const { source } = makeSource(data);
    const crypto = new FakeCrypto();
    const built = await buildExport(
      { source, manifest: makeManifest(data), crypto, codec },
      { passphrase: "correct horse" },
    );
    expect(built.encrypted).toBe(true);
    expect(built.container[9]).toBe(0x01);
    expect([...built.container.subarray(0, 8)]).toEqual([...CONTAINER_MAGIC]);
    const iterations = new DataView(built.container.buffer, built.container.byteOffset).getUint32(
      11,
      false,
    );
    expect(iterations).toBe(PBKDF2_ITERATIONS);
    expect(built.container[15]).toBe(16);
    expect(built.container[33]).toBe(12);
    const sink = makeSink();
    const imported = await importExport(
      { sink, presence: makePresence(), crypto, codec, targetUserVersion: 5 },
      { container: built.container, passphrase: "correct horse" },
    );
    expect(imported.restored).toHaveLength(
      PURE_AUTHORED_TABLES.length + MIXED_AUTHORED_TABLES.length,
    );
    expect(imported.restored.find((row) => row.table === "dedup_confirmation")?.inserted).toBe(2);
  });

  it("(missing-passphrase) encrypted container with no passphrase rejects", async () => {
    const data = populated();
    const { source } = makeSource(data);
    const crypto = new FakeCrypto();
    const built = await buildExport(
      { source, manifest: makeManifest(data), crypto, codec },
      { passphrase: "pw" },
    );
    const sink = makeSink();
    await expect(
      importExport(
        { sink, presence: makePresence(), crypto, codec, targetUserVersion: 5 },
        { container: built.container },
      ),
    ).rejects.toBeInstanceOf(ExportPassphraseRequiredError);
  });

  it("(bad-magic) wrong magic rejects with ExportFormatError", async () => {
    const bytes = new Uint8Array(20);
    bytes.set([1, 2, 3, 4, 5, 6, 7, 8], 0);
    bytes[8] = 1;
    bytes[9] = 0;
    const crypto = new FakeCrypto();
    await expect(decodeContainer(bytes, { codec, crypto }, {})).rejects.toBeInstanceOf(
      ExportFormatError,
    );
  });

  it("(bad-version) byte 8 = 0x02 rejects with a version-2 message", async () => {
    const crypto = new FakeCrypto();
    const good = await encodeContainer({ kind: "x" }, { codec, crypto }, {});
    const bad = good.slice();
    bad[8] = 0x02;
    await expect(decodeContainer(bad, { codec, crypto }, {})).rejects.toThrow(/2/);
    await expect(decodeContainer(bad, { codec, crypto }, {})).rejects.toBeInstanceOf(
      ExportFormatError,
    );
  });

  it("(corrupt-json) plaintext non-JSON payload rejects", async () => {
    const crypto = new FakeCrypto();
    const container = new Uint8Array([
      ...CONTAINER_MAGIC,
      0x01,
      0x00,
      ...codec.encodeUtf8("{not json"),
    ]);
    await expect(decodeContainer(container, { codec, crypto }, {})).rejects.toBeInstanceOf(
      ExportFormatError,
    );
  });

  it("(schema-mismatch) newer store version refused; equal and older accepted", async () => {
    const crypto = new FakeCrypto();
    const build = async (userVersion: number) => {
      const data = populated(userVersion);
      const { source } = makeSource(data);
      return buildExport({ source, manifest: makeManifest(data), crypto, codec }, {});
    };
    const newer = await build(6);
    await expect(
      importExport(
        { sink: makeSink(), presence: makePresence(), crypto, codec, targetUserVersion: 5 },
        { container: newer.container },
      ),
    ).rejects.toBeInstanceOf(ExportSchemaMismatchError);
    for (const v of [5, 4]) {
      const built = await build(v);
      const imported = await importExport(
        { sink: makeSink(), presence: makePresence(), crypto, codec, targetUserVersion: 5 },
        { container: built.container },
      );
      expect(imported.restored).toHaveLength(
        PURE_AUTHORED_TABLES.length + MIXED_AUTHORED_TABLES.length,
      );
    }
  });

  it("(idempotent) second import inserts zero and skips every row", async () => {
    const data = populated();
    const { source } = makeSource(data);
    const crypto = new FakeCrypto();
    const built = await buildExport({ source, manifest: makeManifest(data), crypto, codec }, {});
    const sink = makeSink();
    await importExport(
      { sink, presence: makePresence(), crypto, codec, targetUserVersion: 5 },
      { container: built.container },
    );
    const second = await importExport(
      { sink, presence: makePresence(), crypto, codec, targetUserVersion: 5 },
      { container: built.container },
    );
    for (const r of second.restored) {
      expect(r.inserted).toBe(0);
      expect(r.skipped).toBeGreaterThan(0);
    }
  });

  it("(manifest-report) missing artifacts are reported, never fabricated", async () => {
    const data = populated();
    const { source } = makeSource(data);
    const crypto = new FakeCrypto();
    const built = await buildExport({ source, manifest: makeManifest(data), crypto, codec }, {});
    const presence = makePresence(["aa", "bb"]);
    const imported = await importExport(
      { sink: makeSink(), presence, crypto, codec, targetUserVersion: 5 },
      { container: built.container },
    );
    expect(imported.manifest.total).toBe(3);
    expect(imported.manifest.missing.map((a) => a.address).sort()).toEqual(["aa", "bb"]);
    expect(imported.manifest.present + imported.manifest.missing.length).toBe(
      imported.manifest.total,
    );
  });

  it("(wrong-pass-fake) a different passphrase maps to ExportDecryptionError", async () => {
    const data = populated();
    const { source } = makeSource(data);
    const crypto = new FakeCrypto();
    const built = await buildExport(
      { source, manifest: makeManifest(data), crypto, codec },
      { passphrase: "right" },
    );
    await expect(
      importExport(
        { sink: makeSink(), presence: makePresence(), crypto, codec, targetUserVersion: 5 },
        { container: built.container, passphrase: "wrong" },
      ),
    ).rejects.toBeInstanceOf(ExportDecryptionError);
  });
});
