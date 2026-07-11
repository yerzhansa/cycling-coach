import { link } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { writeTempThenPublish } from "./write-temp.js";

export interface LockfileBody {
  readonly pid: number;
  readonly port: number;
  readonly version: string;
  readonly athleteHome: string;
}

// claimLockfile IS the mutex: link(2) fails EEXIST iff the target exists — the
// same kernel-atomic exclusive-create arbitration as O_CREAT|O_EXCL, but the
// claim is born carrying its full body, so no observer can ever read an empty
// or partial claim. A body is never rewritten in place: a stale claim is
// unlinked and a fresh claim published.
export async function claimLockfile(lockfilePath: string, body: LockfileBody): Promise<void> {
  const serialized = JSON.stringify(body, null, 2) + "\n";
  await writeTempThenPublish(lockfilePath, serialized, (tempPath, targetPath) =>
    link(tempPath, targetPath),
  );
}

export function readLockfile(lockfilePath: string): LockfileBody | null {
  let raw: string;
  try {
    raw = readFileSync(lockfilePath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  const { pid, port, version, athleteHome } = body;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
  if (!Number.isInteger(port) || (port as number) <= 0) return null;
  if (typeof version !== "string" || version.length === 0) return null;
  if (typeof athleteHome !== "string" || athleteHome.length === 0) return null;
  return {
    pid: pid as number,
    port: port as number,
    version,
    athleteHome,
  };
}
