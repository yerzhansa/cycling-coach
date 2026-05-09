// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { open, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";

/**
 * Atomically write a JSON-serialized value to `path` via write-to-temp +
 * fsync + rename. A process kill between open and rename leaves the prior
 * file intact — `safeReadJson` returns either the old or the new content,
 * never a truncated splice. Reference always writes through this helper;
 * never `writeFileSync(path, JSON.stringify(...))` directly.
 *
 * On failure, the temp sibling is best-effort unlinked and the error is
 * rethrown. The on-disk target at `path` is untouched on every failure path
 * because rename is the last step.
 */
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  // Serialize FIRST so circular-reference / BigInt failures don't leave a
  // half-baked temp file on disk.
  const body = JSON.stringify(value, null, 2) + "\n";

  const suffix = randomBytes(4).toString("hex");
  const tempPath = `${path}.tmp.${suffix}`;

  let fh: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fh = await open(tempPath, "w", 0o644);
    await fh.writeFile(body, "utf-8");
    await fh.sync();
    await fh.close();
    fh = null;
    await rename(tempPath, path);
  } catch (err) {
    if (fh !== null) {
      try {
        await fh.close();
      } catch {
        // Ignore — we're already in the error path.
      }
    }
    try {
      await unlink(tempPath);
    } catch {
      // Temp file may not exist (open failed) or rename succeeded already.
    }
    throw err;
  }
}
