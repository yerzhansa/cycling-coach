import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { CryptoPort, FileSystemPort } from "@enduragent/kernel/ports";
import {
  artifactRelPath,
  canonicalJson,
  quarantineRelPath,
  snapshotRelPath,
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

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
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
  async function writeDurable(full: string, bytes: Uint8Array): Promise<void> {
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
  }

  return {
    async writeArtifact(
      bytes: Uint8Array,
      ext: string,
      when: ArchiveInstant,
    ): Promise<ArchiveWriteResult> {
      const address = await addressOf(bytes);
      const relPath = artifactRelPath(address, ext, when);
      const full = join(archiveRoot, relPath);
      if (await exists(full)) {
        return { address, relPath, deduped: true };
      }
      await writeDurable(full, bytes);
      return { address, relPath, deduped: false };
    },

    async writeSnapshot(payload: unknown, when: ArchiveInstant): Promise<ArchiveWriteResult> {
      const raw = Buffer.from(canonicalJson(payload), "utf8");
      const gz = gzipSync(raw, { level: ARCHIVE_GZIP_LEVEL });
      const address = await addressOf(gz);
      const relPath = snapshotRelPath(address, when);
      const full = join(archiveRoot, relPath);
      if (await exists(full)) {
        return { address, relPath, deduped: true };
      }
      await writeDurable(full, gz);
      return { address, relPath, deduped: false };
    },

    async quarantine(
      bytes: Uint8Array,
      ext: string,
      reason: string,
    ): Promise<ArchiveWriteResult> {
      const address = await addressOf(bytes);
      const relPath = quarantineRelPath(address, ext);
      const full = join(archiveRoot, relPath);
      await fs.mkdir(dirname(full), { recursive: true });
      const deduped = await exists(full);
      if (!deduped) {
        await fs.writeFile(full, bytes);
      }
      // Durable reason sidecar: an unparseable payload is never silently
      // dropped — the why is persisted beside the bytes, not merely logged.
      await fs.writeFile(`${full}.reason.txt`, reason);
      return { address, relPath, deduped };
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
