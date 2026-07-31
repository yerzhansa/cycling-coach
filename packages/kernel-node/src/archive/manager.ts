import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { CryptoPort, FileSystemPort } from "@enduragent/kernel/ports";
import type { VerifiedSnapshotReader } from "@enduragent/kernel/reference/local-bundle";
import {
  artifactRelPath,
  canonicalJson,
  quarantineReasonRelPath,
  quarantineRelPath,
  snapshotRelPath,
  toHex,
  type ArchiveInstant,
  type ArchiveManager,
  type ArchiveWriteResult,
} from "@enduragent/kernel/archive";

export const ARCHIVE_GZIP_LEVEL = 6;

export interface ArchiveManagerDeps {
  /** Absolute path to the archive root. NEVER derived from the store/DB dir. */
  readonly archiveRoot: string;
  readonly crypto: CryptoPort;
  readonly fs: FileSystemPort;
}

export function createVerifiedSnapshotReader(deps: ArchiveManagerDeps): VerifiedSnapshotReader {
  return {
    async readVerifiedSnapshot(ref) {
      let compressed: Uint8Array;
      let address: string;
      try {
        compressed = await deps.fs.readFile(join(deps.archiveRoot, ref.rel_path));
        address = toHex(await deps.crypto.sha256(compressed));
      } catch {
        throw new TypeError("archive snapshot read failed");
      }
      if (address !== ref.address) throw new TypeError("archive snapshot address mismatch");
      try {
        return JSON.parse(gunzipSync(compressed).toString("utf8"));
      } catch {
        throw new TypeError("archive snapshot is invalid");
      }
    },
  };
}

export function createArchiveManager(deps: ArchiveManagerDeps): ArchiveManager {
  const { archiveRoot, crypto, fs } = deps;

  async function addressOf(bytes: Uint8Array): Promise<string> {
    return toHex(await crypto.sha256(bytes));
  }

  async function exists(full: string): Promise<boolean> {
    return (await fs.stat(full)) !== undefined;
  }

  // Durable write through the injected FileSystem port: its writeFile is the
  // atomic temp->fsync->rename seam, so a mid-write kill leaves the old file or
  // nothing, never a truncated artifact. The manager holds no deletion path
  // over committed archive content.
  async function writeDurable(full: string, data: Uint8Array | string): Promise<void> {
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async function commit(
    address: string,
    relPath: string,
    bytes: Uint8Array,
  ): Promise<ArchiveWriteResult> {
    const full = join(archiveRoot, relPath);
    if (await exists(full)) {
      return { address, relPath, deduped: true };
    }
    await writeDurable(full, bytes);
    return { address, relPath, deduped: false };
  }

  return {
    async writeArtifact(
      bytes: Uint8Array,
      ext: string,
      when: ArchiveInstant,
    ): Promise<ArchiveWriteResult> {
      const address = await addressOf(bytes);
      return commit(address, artifactRelPath(address, ext, when), bytes);
    },

    async writeSnapshot(payload: unknown, when: ArchiveInstant): Promise<ArchiveWriteResult> {
      const raw = Buffer.from(canonicalJson(payload), "utf8");
      const gz = gzipSync(raw, { level: ARCHIVE_GZIP_LEVEL });
      const address = await addressOf(gz);
      return commit(address, snapshotRelPath(address, when), gz);
    },

    async quarantine(
      bytes: Uint8Array,
      ext: string,
      reason: string,
    ): Promise<ArchiveWriteResult> {
      const address = await addressOf(bytes);
      const result = await commit(address, quarantineRelPath(address, ext), bytes);
      // Durable reason sidecar: an unparseable payload is never silently
      // dropped — the why is persisted beside the bytes, not merely logged.
      // First reason wins: committed archive-adjacent content is never rewritten.
      const reasonFull = join(archiveRoot, quarantineReasonRelPath(address, ext));
      if (!(await exists(reasonFull))) {
        await writeDurable(reasonFull, reason);
      }
      return result;
    },

    async readArtifact(relPath: string): Promise<Uint8Array> {
      return fs.readFile(join(archiveRoot, relPath));
    },

    async readSnapshot(relPath: string): Promise<unknown> {
      const gz = await fs.readFile(join(archiveRoot, relPath));
      return JSON.parse(gunzipSync(gz).toString("utf8"));
    },

    async has(relPath: string): Promise<boolean> {
      return exists(join(archiveRoot, relPath));
    },
  };
}
