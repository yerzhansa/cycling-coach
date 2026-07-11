import { describe, it, expect } from "vitest";
import {
  buildExport,
  importExport,
  PBKDF2_ITERATIONS,
  PURE_AUTHORED_TABLES,
  MIXED_AUTHORED_TABLES,
  ExportDecryptionError,
  type ArchiveArtifact,
  type AuthoredRow,
  type ExportSource,
  type ArchiveManifestReader,
  type ImportSink,
  type ArchivePresenceChecker,
  type RestoreTableResult,
} from "@enduragent/kernel/store/export";
import { webCryptoExportEnv } from "@enduragent/kernel-node/store-export";

const { crypto, codec } = webCryptoExportEnv;

interface Populated {
  readonly userVersion: number;
  readonly rows: Record<string, readonly AuthoredRow[]>;
  readonly artifacts: readonly ArchiveArtifact[];
}

function populated(userVersion = 3): Populated {
  const rows: Record<string, readonly AuthoredRow[]> = {};
  for (const t of PURE_AUTHORED_TABLES) rows[t] = [{ id: `${t}-1`, v: 1 }, { id: `${t}-2`, note: "üñïçödé" }];
  for (const t of MIXED_AUTHORED_TABLES) rows[t] = [{ id: `${t}-m1`, provenance: "manual" }];
  const artifacts: ArchiveArtifact[] = [
    { address: "aa", relPath: "archive/2026/06/aa/aa.fit", bytes: 20, kind: "fit" },
    { address: "bb", relPath: "archive/2026/06/bb/bb.tcx", bytes: 30, kind: "tcx" },
  ];
  return { userVersion, rows, artifacts };
}

function makeSource(data: Populated): ExportSource {
  return {
    async readUserVersion() {
      return data.userVersion;
    },
    async readAuthoredTable(table) {
      return data.rows[table] ?? [];
    },
  };
}

function makeManifest(data: Populated): ArchiveManifestReader {
  return {
    async listArtifacts() {
      return data.artifacts;
    },
  };
}

function makeSink(): ImportSink & { stored: Map<string, AuthoredRow[]> } {
  const stored = new Map<string, AuthoredRow[]>();
  return {
    stored,
    async restoreAuthoredTable(table, rows): Promise<RestoreTableResult> {
      let list = stored.get(table);
      if (!list) {
        list = [];
        stored.set(table, list);
      }
      let inserted = 0;
      let skipped = 0;
      for (const row of rows) {
        const key = JSON.stringify(row);
        if (list.some((r) => JSON.stringify(r) === key)) skipped += 1;
        else {
          list.push(row);
          inserted += 1;
        }
      }
      return { table, inserted, skipped };
    },
  };
}

function makePresence(): ArchivePresenceChecker {
  return {
    async hasArtifact() {
      return true;
    },
  };
}

describe("store export op with real WebCrypto", () => {
  it("(real-roundtrip-nopass) restores every authored row without a passphrase", async () => {
    const data = populated();
    const built = await buildExport(
      { source: makeSource(data), manifest: makeManifest(data), crypto, codec },
      {},
    );
    const sink = makeSink();
    await importExport(
      { sink, presence: makePresence(), crypto, codec, targetUserVersion: 5 },
      { container: built.container },
    );
    for (const t of [...PURE_AUTHORED_TABLES, ...MIXED_AUTHORED_TABLES]) {
      expect(sink.stored.get(t)).toEqual(data.rows[t]);
    }
  });

  it("(real-roundtrip-pass) round-trips with a multibyte passphrase", async () => {
    const data = populated();
    const built = await buildExport(
      { source: makeSource(data), manifest: makeManifest(data), crypto, codec },
      { passphrase: "s3kr3t-üñïçödé" },
    );
    const sink = makeSink();
    await importExport(
      { sink, presence: makePresence(), crypto, codec, targetUserVersion: 5 },
      { container: built.container, passphrase: "s3kr3t-üñïçödé" },
    );
    for (const t of [...PURE_AUTHORED_TABLES, ...MIXED_AUTHORED_TABLES]) {
      expect(sink.stored.get(t)).toEqual(data.rows[t]);
    }
  });

  it("(wrong-pass) a wrong passphrase rejects with ExportDecryptionError", async () => {
    const data = populated();
    const built = await buildExport(
      { source: makeSource(data), manifest: makeManifest(data), crypto, codec },
      { passphrase: "right" },
    );
    await expect(
      importExport(
        { sink: makeSink(), presence: makePresence(), crypto, codec, targetUserVersion: 5 },
        { container: built.container, passphrase: "wrong" },
      ),
    ).rejects.toBeInstanceOf(ExportDecryptionError);
  });

  it("(tamper-ciphertext) flipping a ciphertext bit rejects with ExportDecryptionError", async () => {
    const data = populated();
    const built = await buildExport(
      { source: makeSource(data), manifest: makeManifest(data), crypto, codec },
      { passphrase: "pw" },
    );
    const tampered = built.container.slice();
    tampered[tampered.length - 1] ^= 0x01;
    await expect(
      importExport(
        { sink: makeSink(), presence: makePresence(), crypto, codec, targetUserVersion: 5 },
        { container: tampered, passphrase: "pw" },
      ),
    ).rejects.toBeInstanceOf(ExportDecryptionError);
  });

  it("(tamper-header) flipping a nonce/AAD bit rejects with ExportDecryptionError", async () => {
    const data = populated();
    const built = await buildExport(
      { source: makeSource(data), manifest: makeManifest(data), crypto, codec },
      { passphrase: "pw" },
    );
    const tampered = built.container.slice();
    tampered[34] ^= 0x01;
    await expect(
      importExport(
        { sink: makeSink(), presence: makePresence(), crypto, codec, targetUserVersion: 5 },
        { container: tampered, passphrase: "pw" },
      ),
    ).rejects.toBeInstanceOf(ExportDecryptionError);
  });

  it("(iterations-floor) container ITERATIONS field equals PBKDF2_ITERATIONS >= 600000", async () => {
    const data = populated();
    const built = await buildExport(
      { source: makeSource(data), manifest: makeManifest(data), crypto, codec },
      { passphrase: "pw" },
    );
    const iterations = new DataView(
      built.container.buffer,
      built.container.byteOffset,
    ).getUint32(11, false);
    expect(iterations).toBe(PBKDF2_ITERATIONS);
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
  });
});
