import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { enumerateTelegramSessions } from "./telegram-sessions.js";

export type DmPolicy = "pairing" | "allowlist" | "open";

export const ALLOWED_SENDERS_FILE = "allowed-senders.json";

export interface AllowedSenders {
  version: 1;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  primaryOperator: string | null;
  capturedAt: string | null;
  addedAt: Record<string, string>;
  [unknownKey: string]: unknown;
}

export function defaultPairingState(): AllowedSenders {
  return {
    version: 1,
    dmPolicy: "pairing",
    allowFrom: [],
    primaryOperator: null,
    capturedAt: null,
    addedAt: {},
  };
}

/**
 * Telegram user-ids: positive integer with at least 2 digits, no leading zero.
 * Telegram never assigns 0 or single-digit IDs; the regex rejects malformed
 * env-var fragments and bare 0 while staying length-agnostic on the high end.
 */
export const SENDER_ID_RE = /^[1-9]\d+$/;
const OPERATOR_ID_ENV = "CYCLING_COACH_OPERATOR_ID";
const DM_POLICY_ENV = "CYCLING_COACH_DM_POLICY";

function loadFromEnv(): AllowedSenders | null {
  const raw = process.env[OPERATOR_ID_ENV];
  if (raw === undefined || raw === "") return null;
  if (!SENDER_ID_RE.test(raw)) {
    console.error(
      `[security] ${OPERATOR_ID_ENV}="${raw}" is not a valid Telegram user-id (must be a positive integer ≥ 2 digits, no leading zero). Falling through to default.`,
    );
    return null;
  }
  return {
    version: 1,
    dmPolicy: "allowlist",
    allowFrom: [raw],
    primaryOperator: raw,
    capturedAt: null,
    addedAt: {},
  };
}

// Zod accepts file shapes that originated from older revisions or hand-edits:
// strings/numbers in `allowFrom` are coerced to strings, invalid items are
// dropped (with a stderr warning per item), unknown top-level fields pass
// through for forward-compat. `dmPolicy: "open"` is rejected here on purpose —
// it can only be set via the CYCLING_COACH_DM_POLICY env var.
const senderIdSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((s) => SENDER_ID_RE.test(s));

function validateSchema(parsed: unknown, path: string): AllowedSenders | null {
  const schema = z
    .object({
      version: z.literal(1),
      dmPolicy: z.union([z.literal("pairing"), z.literal("allowlist")]),
      allowFrom: z.array(z.unknown()).transform((arr) => {
        const out: string[] = [];
        for (const item of arr) {
          const r = senderIdSchema.safeParse(item);
          if (r.success) out.push(r.data);
          else console.error(
            `[security] ${path}: dropped invalid allowFrom entry ${JSON.stringify(item)}.`,
          );
        }
        return out;
      }),
      primaryOperator: z.union([z.string().regex(SENDER_ID_RE), z.null()]).optional(),
      capturedAt: z.string().nullable().optional(),
      addedAt: z.record(z.string(), z.string()).optional(),
    })
    .passthrough();

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join(".") || "root";
    console.error(
      `[security] ${path}: invalid ${field}; falling back to default-pairing.`,
    );
    return null;
  }
  if (result.data.allowFrom.length === 0 && result.data.dmPolicy === "allowlist") {
    console.error(
      `[security] ${path}: allowlist mode with no valid allowFrom entries; falling back to default-pairing.`,
    );
    return null;
  }
  return result.data as AllowedSenders;
}

function loadFromFile(dataDir: string): AllowedSenders | null {
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[security] ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); falling back to default-pairing.`,
    );
    return null;
  }
  return validateSchema(parsed, path);
}

// Cache parsed AllowedSenders by file mtime. The auth middleware calls
// loadAllowedSenders on every inbound message; caching avoids re-running JSON
// parse + zod validation when the file hasn't changed. saveAllowedSenders
// invalidates this cache after committing a write. Note: cache is keyed by
// dataDir so a single process serving multiple homes still works.
//
// HFS+ has 1-second mtime granularity — two writes within the same second
// won't invalidate. macOS APFS, Linux ext4, and NTFS are sub-millisecond.
// Telegram caps inbound to 30 msg/sec/bot so this is a non-issue in practice.
const fileCache = new Map<string, { mtimeMs: number; value: AllowedSenders }>();

function loadFromFileCached(dataDir: string): AllowedSenders | null {
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    fileCache.delete(dataDir);
    return null;
  }
  const cached = fileCache.get(dataDir);
  if (cached && cached.mtimeMs === mtimeMs) return cached.value;
  const fresh = loadFromFile(dataDir);
  if (fresh) fileCache.set(dataDir, { mtimeMs, value: fresh });
  else fileCache.delete(dataDir);
  return fresh;
}

export type AllowedSendersSource = "file" | "env" | "default-pairing";

export interface AllowedSendersLoad {
  state: AllowedSenders;
  source: AllowedSendersSource;
}

export function loadAllowedSendersWithSource(dataDir: string): AllowedSendersLoad {
  const fromFile = loadFromFileCached(dataDir);
  const baseAndSource: AllowedSendersLoad = fromFile
    ? { state: fromFile, source: "file" }
    : (() => {
        const fromEnv = loadFromEnv();
        return fromEnv
          ? { state: fromEnv, source: "env" }
          : { state: defaultPairingState(), source: "default-pairing" };
      })();

  // CYCLING_COACH_DM_POLICY=open is env-var-only (cannot be set via file). The
  // override preserves base.allowFrom so notifyUpdate's filter still has the
  // operator's friends list to broadcast to. Source flips to "env" since the
  // override is what determined the effective policy.
  if (process.env[DM_POLICY_ENV] === "open") {
    return { state: { ...baseAndSource.state, dmPolicy: "open" }, source: "env" };
  }
  return baseAndSource;
}

export function loadAllowedSenders(dataDir: string): AllowedSenders {
  return loadAllowedSendersWithSource(dataDir).state;
}

// ─── PID lockfile ────────────────────────────────────────────────────────────
// Serialize cross-process writes to allowed-senders.json. Lockfile lives at
// <dataDir>/.allowed-senders.lock; content is "<pid>\n<isoTimestamp>". Stale
// locks (dead PID OR timestamp older than 60s) are reclaimed automatically.

const LOCK_FILE = ".allowed-senders.lock";
const LOCK_FRESH_WINDOW_MS = 60_000;

export class LockfileContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockfileContentionError";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but we lack signal perms (still alive).
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function lockfileIsStale(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch {
    return true;
  }
  const [pidStr, ts] = raw.split("\n");
  const pid = Number(pidStr);
  if (!Number.isFinite(pid) || pid <= 0) return true;
  const tsMs = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(tsMs)) return true;
  if (Date.now() - tsMs > LOCK_FRESH_WINDOW_MS) return true;
  if (!isProcessAlive(pid)) return true;
  return false;
}

function acquireLockfile(dataDir: string): string {
  const lockPath = join(dataDir, LOCK_FILE);
  const content = `${process.pid}\n${new Date().toISOString()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
      return lockPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (lockfileIsStale(lockPath)) {
        try { unlinkSync(lockPath); } catch { /* race: another process cleaned it */ }
        continue;
      }
      throw new LockfileContentionError(
        `Another ${process.argv[1] ?? "cycling-coach"} process holds ${lockPath}; try again in a moment.`,
      );
    }
  }
  throw new LockfileContentionError(`Failed to acquire ${lockPath} after stale-reclaim retry.`);
}

function releaseLockfile(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone or never created — nothing to do.
  }
}

export function ensureDataDirSecure(dataDir: string): void {
  // mkdirSync with `mode` is a no-op on existing dirs, so explicit chmod is the
  // only path that tightens upgrade installs that pre-date this enforcement.
  if (existsSync(dataDir)) {
    const mode = statSync(dataDir).mode & 0o777;
    if (mode !== 0o700) {
      chmodSync(dataDir, 0o700);
      console.error(
        `[security] Tightened ${dataDir} permissions from 0o${mode.toString(8)} to 0o700.`,
      );
    }
  } else {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
}

export function saveAllowedSenders(
  dataDir: string,
  transform: (current: AllowedSenders | null) => AllowedSenders,
): AllowedSenders {
  ensureDataDirSecure(dataDir);

  const lockPath = acquireLockfile(dataDir);
  try {
    // Read inside the lock so the transformer sees the latest disk state —
    // closes a TOCTOU class where a load-then-save outside the lock could
    // clobber a concurrent writer's commit. Bypass the mtime cache here: the
    // cache reflects the LAST committed write from this process, but a peer
    // process may have written since then and we must see that.
    const current = loadFromFile(dataDir);
    const next = transform(current);

    const path = join(dataDir, ALLOWED_SENDERS_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    // Refresh the cache with the fresh state + post-rename mtime so the next
    // read in this process is a cache hit.
    try {
      fileCache.set(dataDir, { mtimeMs: statSync(path).mtimeMs, value: next });
    } catch {
      fileCache.delete(dataDir);
    }
    return next;
  } finally {
    releaseLockfile(lockPath);
  }
}

function assertSenderId(id: string): void {
  if (!SENDER_ID_RE.test(id)) {
    throw new Error(
      `Invalid sender id ${JSON.stringify(id)}: must be a positive integer (≥ 2 digits, no leading zero).`,
    );
  }
}

export function addSender(dataDir: string, senderId: string): void {
  assertSenderId(senderId);
  const nowIso = new Date().toISOString();
  saveAllowedSenders(dataDir, (current) => {
    const base = current ?? defaultPairingState();
    if (base.allowFrom.includes(senderId)) {
      // Idempotent — keep dmPolicy "allowlist" if it isn't already.
      if (base.dmPolicy === "pairing") {
        return { ...base, dmPolicy: "allowlist" };
      }
      return base;
    }
    return {
      ...base,
      dmPolicy: "allowlist",
      allowFrom: [...base.allowFrom, senderId],
      addedAt: { ...base.addedAt, [senderId]: nowIso },
      primaryOperator: base.primaryOperator ?? senderId,
    };
  });
}

interface SessionCandidate {
  chatId: string;
  lineCount: number;
  mtime: number;
  lastModified: string;
}

async function countLines(path: string): Promise<number> {
  let n = 0;
  let lastByte = -1;
  try {
    for await (const buf of createReadStream(path) as AsyncIterable<Buffer>) {
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) n++;
        lastByte = buf[i];
      }
    }
  } catch {
    return 0;
  }
  // Trailing content without a final newline still counts as one line.
  if (lastByte !== -1 && lastByte !== 0x0a) n++;
  return n;
}

export async function readKnownSessions(dataDir: string): Promise<SessionCandidate[]> {
  const sessions = enumerateTelegramSessions(dataDir);
  return Promise.all(
    sessions.map(async (s) => ({
      chatId: s.chatId,
      lineCount: await countLines(s.path),
      mtime: s.mtimeMs,
      lastModified: new Date(s.mtimeMs).toISOString(),
    })),
  );
}

export async function listSenders(dataDir: string): Promise<{
  senders: AllowedSenders;
  sessionCandidates: SessionCandidate[];
}> {
  return {
    senders: loadAllowedSenders(dataDir),
    sessionCandidates: await readKnownSessions(dataDir),
  };
}

export function removeSender(dataDir: string, senderId: string): void {
  saveAllowedSenders(dataDir, (current) => {
    if (!current) return defaultPairingState();
    if (!current.allowFrom.includes(senderId)) return current;
    const filtered = current.allowFrom.filter((id) => id !== senderId);
    const { [senderId]: _dropped, ...remainingAddedAt } = current.addedAt;
    return {
      ...current,
      allowFrom: filtered,
      addedAt: remainingAddedAt,
      dmPolicy: filtered.length === 0 ? "pairing" : current.dmPolicy,
      primaryOperator:
        current.primaryOperator === senderId ? null : current.primaryOperator,
    };
  });
}
