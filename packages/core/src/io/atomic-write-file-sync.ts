import {
  closeSync,
  fdatasyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

/**
 * Synchronous atomic-write of UTF-8 text content. Writes to a temp sibling,
 * fdatasyncs, then renames to the target. On any failure the temp file is
 * unlinked and the target at `path` (if any) is left untouched.
 *
 * Sync because the existing `MemoryStore` API surface is sync (writeSection,
 * renameSection, appendDailyNote). The Reference module uses the async
 * `atomicWriteJson` helper for its persisted state.
 */
export function atomicWriteFileSync(path: string, content: string): void {
  const tempPath = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, "w", 0o600);
    writeSync(fd, content, null, "utf-8");
    fdatasyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore — we're already in the error path.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // Temp may not exist (open failed) or rename succeeded already.
    }
    throw err;
  }
}
