import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { enumerateTelegramSessions } from "./telegram-sessions.js";

export type DmPolicy = "pairing" | "allowlist" | "open";

export const ALLOWED_SENDERS_FILE = "allowed-senders.json";
const ACCESS_RESET_MARKER = ".telegram-access-reset";

export interface AllowedSenders {
  version: 1;
  dmPolicy: DmPolicy;
  allowFrom: string[];
  primaryOperator: string | null;
  capturedAt: string | null;
  addedAt: Record<string, string>;
  desktopBotId?: string;
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
          else
            console.error(
              `[security] ${path}: dropped invalid allowFrom entry ${JSON.stringify(item)}.`,
            );
        }
        return out;
      }),
      primaryOperator: z.union([z.string().regex(SENDER_ID_RE), z.null()]).optional(),
      capturedAt: z.string().nullable().optional(),
      addedAt: z.record(z.string(), z.string()).optional(),
      desktopBotId: z.string().regex(SENDER_ID_RE).optional(),
    })
    .passthrough();

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join(".") || "root";
    console.error(`[security] ${path}: invalid ${field}; falling back to default-pairing.`);
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

// Cache parsed AllowedSenders by file identity. The auth middleware calls
// loadAllowedSenders on every inbound message; caching avoids re-running JSON
// parse + zod validation when the file hasn't changed. saveAllowedSenders
// invalidates this cache after committing a write. Note: cache is keyed by
// dataDir so a single process serving multiple homes still works.
interface AllowedSendersFileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

const fileCache = new Map<
  string,
  { identity: AllowedSendersFileIdentity; value: AllowedSenders }
>();
const uncertainAccessFences = new Set<string>();

function allowedSendersFileIdentity(path: string): AllowedSendersFileIdentity {
  const metadata = statSync(path, { bigint: true });
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
  };
}

function sameAllowedSendersFileIdentity(
  left: AllowedSendersFileIdentity,
  right: AllowedSendersFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function pathExistsOrIsUninspectable(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function accessFenceActive(dataDir: string): boolean {
  return (
    uncertainAccessFences.has(dataDir) ||
    pathExistsOrIsUninspectable(join(dataDir, ACCESS_RESET_MARKER))
  );
}

function loadFromFileCached(dataDir: string): AllowedSenders | null {
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  let identity: AllowedSendersFileIdentity;
  try {
    identity = allowedSendersFileIdentity(path);
  } catch {
    fileCache.delete(dataDir);
    return null;
  }
  const cached = fileCache.get(dataDir);
  if (cached && sameAllowedSendersFileIdentity(cached.identity, identity)) return cached.value;
  const fresh = loadFromFile(dataDir);
  if (fresh) fileCache.set(dataDir, { identity, value: fresh });
  else fileCache.delete(dataDir);
  return fresh;
}

export type AllowedSendersSource = "file" | "env" | "default-pairing";

export interface AllowedSendersLoad {
  state: AllowedSenders;
  source: AllowedSendersSource;
}

export function loadAllowedSendersWithSource(dataDir: string): AllowedSendersLoad {
  if (accessFenceActive(dataDir)) {
    return { state: defaultPairingState(), source: "default-pairing" };
  }
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

export function loadAllowedSendersFromFile(dataDir: string): AllowedSenders {
  if (accessFenceActive(dataDir)) return defaultPairingState();
  return loadFromFileCached(dataDir) ?? defaultPairingState();
}

export interface DesktopAllowedSender {
  senderId: string;
  role: "primary" | "additional";
  addedAt?: string;
}

export type ClaimPrimaryOperatorResult =
  | {
      status: "claimed" | "already-primary";
      sender: DesktopAllowedSender;
    }
  | {
      status: "refused";
      reason: "primary-exists" | "inconsistent-state";
    }
  | { status: "uncertain" };

export type AddSecondarySenderResult =
  | {
      status: "added" | "already-allowed";
      sender: DesktopAllowedSender;
    }
  | { status: "uncertain" }
  | {
      status: "refused";
      reason: "primary-required" | "inconsistent-state";
    };

export type RemoveSecondarySenderResult =
  | { status: "removed" | "not-found" }
  | { status: "uncertain" }
  | {
      status: "refused";
      reason: "primary-removal" | "inconsistent-state";
    };

// ─── PID lockfile ────────────────────────────────────────────────────────────
// Serialize cross-process writes to allowed-senders.json. Lockfile lives at
// <dataDir>/.allowed-senders.lock. Locks owned by a dead PID are reclaimed.

const LOCK_FILE = ".allowed-senders.lock";

export class LockfileContentionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockfileContentionError";
  }
}

export class AllowedSendersRecoveryRequiredError extends Error {
  constructor(dataDir: string) {
    super(`Telegram sender authorization recovery is required for ${dataDir}.`);
    this.name = "AllowedSendersRecoveryRequiredError";
  }
}

export class AllowedSendersCommitUncertainError extends Error {
  constructor(dataDir: string, cause: unknown) {
    super(`Telegram sender authorization commit is uncertain for ${dataDir}.`, { cause });
    this.name = "AllowedSendersCommitUncertainError";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Only ESRCH proves the process is gone. Permission and I/O failures must
    // preserve the lock because they do not prove its owner is dead.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockfileIsStale(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const [pidStr] = raw.split("\n");
  const pid = Number(pidStr);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  return !isProcessAlive(pid);
}

interface LockfileOwnership {
  path: string;
  content: string;
}

function prepareLockfileClaim(lockPath: string, content: string, token: string): string {
  const tempPath = `${lockPath}.tmp.${token}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    return tempPath;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    try {
      unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function acquireLockfile(dataDir: string): LockfileOwnership {
  const lockPath = join(dataDir, LOCK_FILE);
  const token = randomUUID();
  const content = `${process.pid}\n${new Date().toISOString()}\n${token}`;
  const tempPath = prepareLockfileClaim(lockPath, content, token);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tempPath, lockPath);
        return { path: lockPath, content };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (lockfileIsStale(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* race: another process cleaned it */
          }
          continue;
        }
        throw new LockfileContentionError(
          `Another ${process.argv[1] ?? "cycling-coach"} process holds ${lockPath}; try again in a moment.`,
        );
      }
    }
    throw new LockfileContentionError(`Failed to acquire ${lockPath} after stale-reclaim retry.`);
  } finally {
    try {
      unlinkSync(tempPath);
    } catch {}
  }
}

function releaseLockfile(ownership: LockfileOwnership): void {
  try {
    if (readFileSync(ownership.path, "utf8") !== ownership.content) return;
    unlinkSync(ownership.path);
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

function syncDirectory(dataDir: string): void {
  const descriptor = openSync(
    dataDir,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeFileDurably(path: string, contents: string): void {
  const descriptor = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function withAllowedSendersLock<T>(dataDir: string, operation: () => T): T {
  ensureDataDirSecure(dataDir);
  const ownership = acquireLockfile(dataDir);
  try {
    return operation();
  } finally {
    releaseLockfile(ownership);
  }
}

function publishAccessFenceLocked(dataDir: string): void {
  uncertainAccessFences.add(dataDir);
  fileCache.delete(dataDir);
  writeFileDurably(join(dataDir, ACCESS_RESET_MARKER), "reset\n");
  syncDirectory(dataDir);
}

function removeAccessFenceLocked(dataDir: string): void {
  const markerPath = join(dataDir, ACCESS_RESET_MARKER);
  let unlinked = false;
  try {
    unlinkSync(markerPath);
    unlinked = true;
    syncDirectory(dataDir);
    uncertainAccessFences.delete(dataDir);
  } catch (error) {
    uncertainAccessFences.add(dataDir);
    if (unlinked) {
      try {
        writeFileDurably(markerPath, "reset\n");
        syncDirectory(dataDir);
      } catch {}
    }
    throw error;
  }
}

function refreshAllowedSendersCache(dataDir: string, next: AllowedSenders): void {
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  try {
    fileCache.set(dataDir, { identity: allowedSendersFileIdentity(path), value: next });
  } catch {
    fileCache.delete(dataDir);
  }
}

function replaceAllowedSendersLocked(dataDir: string, next: AllowedSenders): void {
  const path = join(dataDir, ALLOWED_SENDERS_FILE);
  const tmp = `${path}.tmp`;
  let renamed = false;
  try {
    writeFileDurably(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    renamed = true;
    syncDirectory(dataDir);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    if (renamed) throw new AllowedSendersCommitUncertainError(dataDir, error);
    throw error;
  }
}

function commitAllowedSendersLocked(dataDir: string, next: AllowedSenders): AllowedSenders {
  publishAccessFenceLocked(dataDir);
  try {
    replaceAllowedSendersLocked(dataDir, next);
    try {
      removeAccessFenceLocked(dataDir);
    } catch (error) {
      throw new AllowedSendersCommitUncertainError(dataDir, error);
    }
  } catch (error) {
    uncertainAccessFences.add(dataDir);
    fileCache.delete(dataDir);
    throw error;
  }
  refreshAllowedSendersCache(dataDir, next);
  return next;
}

function recoveryState(current: AllowedSenders | null): AllowedSenders {
  return {
    ...defaultPairingState(),
    ...(current?.desktopBotId === undefined ? {} : { desktopBotId: current.desktopBotId }),
  };
}

function mutateAllowedSenders(
  dataDir: string,
  transform: (current: AllowedSenders | null) => AllowedSenders,
  recoverPendingFence: boolean,
): AllowedSenders {
  return withAllowedSendersLock(dataDir, () => {
    let current = loadFromFile(dataDir);
    if (accessFenceActive(dataDir)) {
      if (!recoverPendingFence) throw new AllowedSendersRecoveryRequiredError(dataDir);
      current = commitAllowedSendersLocked(dataDir, recoveryState(current));
    }
    const next = transform(current);
    if (next === current) return next;
    return commitAllowedSendersLocked(dataDir, next);
  });
}

export function saveAllowedSenders(
  dataDir: string,
  transform: (current: AllowedSenders | null) => AllowedSenders,
): AllowedSenders {
  return mutateAllowedSenders(dataDir, transform, false);
}

export function resetDesktopAllowedSenders(dataDir: string): void {
  withAllowedSendersLock(dataDir, () => {
    commitAllowedSendersLocked(dataDir, recoveryState(loadFromFile(dataDir)));
  });
}

export function bindDesktopTelegramAccess(
  dataDir: string,
  desktopBotId: string,
): "preserved" | "reset" {
  if (!SENDER_ID_RE.test(desktopBotId)) {
    throw new TypeError("invalid Desktop Telegram bot id");
  }
  return withAllowedSendersLock(dataDir, () => {
    const pendingReset = accessFenceActive(dataDir);
    const current = loadFromFile(dataDir);
    if (!pendingReset && current?.desktopBotId === desktopBotId) return "preserved";
    commitAllowedSendersLocked(dataDir, { ...defaultPairingState(), desktopBotId });
    return "reset";
  });
}

function assertSenderId(id: string): void {
  if (!SENDER_ID_RE.test(id)) {
    throw new Error(
      `Invalid sender id ${JSON.stringify(id)}: must be a positive integer (≥ 2 digits, no leading zero).`,
    );
  }
}

function desktopSender(state: AllowedSenders, senderId: string): DesktopAllowedSender {
  const addedAt =
    state.addedAt?.[senderId] ??
    (state.primaryOperator === senderId ? (state.capturedAt ?? undefined) : undefined);
  return {
    senderId,
    role: state.primaryOperator === senderId ? "primary" : "additional",
    ...(addedAt === undefined ? {} : { addedAt }),
  };
}

function hasUniqueSenderIds(state: AllowedSenders): boolean {
  return new Set(state.allowFrom).size === state.allowFrom.length;
}

function hasValidPrimary(state: AllowedSenders): boolean {
  return (
    state.dmPolicy === "allowlist" &&
    typeof state.primaryOperator === "string" &&
    SENDER_ID_RE.test(state.primaryOperator) &&
    hasUniqueSenderIds(state) &&
    state.allowFrom.includes(state.primaryOperator)
  );
}

function hasConsistentUnownedState(state: AllowedSenders): boolean {
  return (
    state.dmPolicy === "pairing" &&
    (state.primaryOperator === null || state.primaryOperator === undefined) &&
    state.allowFrom.length === 0
  );
}

class DesktopSenderMutationExit<T> extends Error {
  constructor(readonly result: T) {
    super("Desktop sender mutation exited without a write.");
  }
}

function exitDesktopMutation<T>(result: T): never {
  throw new DesktopSenderMutationExit(result);
}

function allowedSendersFileExists(dataDir: string): boolean {
  return pathExistsOrIsUninspectable(join(dataDir, ALLOWED_SENDERS_FILE));
}

export function claimPrimaryOperator(
  dataDir: string,
  senderId: string,
): ClaimPrimaryOperatorResult {
  assertSenderId(senderId);
  const nowIso = new Date().toISOString();
  let result: ClaimPrimaryOperatorResult | undefined;

  try {
    saveAllowedSenders(dataDir, (current) => {
      if (!current && allowedSendersFileExists(dataDir)) {
        return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
      }

      const base = current ?? defaultPairingState();
      if (hasValidPrimary(base)) {
        if (base.primaryOperator !== senderId) {
          return exitDesktopMutation({ status: "refused", reason: "primary-exists" });
        }
        return exitDesktopMutation({
          status: "already-primary",
          sender: desktopSender(base, senderId),
        });
      }
      if (!hasConsistentUnownedState(base)) {
        return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
      }

      const next: AllowedSenders = {
        ...base,
        dmPolicy: "allowlist",
        allowFrom: [senderId],
        primaryOperator: senderId,
        capturedAt: nowIso,
        addedAt: { ...base.addedAt, [senderId]: nowIso },
      };
      result = { status: "claimed", sender: desktopSender(next, senderId) };
      return next;
    });
  } catch (err) {
    if (err instanceof DesktopSenderMutationExit) {
      return err.result as ClaimPrimaryOperatorResult;
    }
    if (err instanceof AllowedSendersRecoveryRequiredError) {
      return { status: "refused", reason: "inconsistent-state" };
    }
    if (err instanceof AllowedSendersCommitUncertainError) {
      return { status: "uncertain" };
    }
    throw err;
  }

  return result as ClaimPrimaryOperatorResult;
}

export function addSecondarySender(dataDir: string, senderId: string): AddSecondarySenderResult {
  assertSenderId(senderId);
  const nowIso = new Date().toISOString();
  let result: AddSecondarySenderResult | undefined;

  try {
    saveAllowedSenders(dataDir, (current) => {
      if (!current && allowedSendersFileExists(dataDir)) {
        return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
      }

      const base = current ?? defaultPairingState();
      if (hasConsistentUnownedState(base)) {
        return exitDesktopMutation({ status: "refused", reason: "primary-required" });
      }
      if (!hasValidPrimary(base)) {
        return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
      }
      if (base.allowFrom.includes(senderId)) {
        return exitDesktopMutation({
          status: "already-allowed",
          sender: desktopSender(base, senderId),
        });
      }

      const next: AllowedSenders = {
        ...base,
        allowFrom: [...base.allowFrom, senderId],
        addedAt: { ...base.addedAt, [senderId]: nowIso },
      };
      result = { status: "added", sender: desktopSender(next, senderId) };
      return next;
    });
  } catch (err) {
    if (err instanceof DesktopSenderMutationExit) {
      return err.result as AddSecondarySenderResult;
    }
    if (err instanceof AllowedSendersRecoveryRequiredError) {
      return { status: "refused", reason: "inconsistent-state" };
    }
    if (err instanceof AllowedSendersCommitUncertainError) {
      return { status: "uncertain" };
    }
    throw err;
  }

  return result as AddSecondarySenderResult;
}

export function removeSecondarySender(
  dataDir: string,
  senderId: string,
): RemoveSecondarySenderResult {
  assertSenderId(senderId);
  let result: RemoveSecondarySenderResult | undefined;

  try {
    mutateAllowedSenders(
      dataDir,
      (current) => {
        if (!current && allowedSendersFileExists(dataDir)) {
          return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
        }

        const base = current ?? defaultPairingState();
        if (hasConsistentUnownedState(base)) {
          return exitDesktopMutation({ status: "not-found" });
        }
        if (!hasValidPrimary(base)) {
          return exitDesktopMutation({ status: "refused", reason: "inconsistent-state" });
        }
        if (base.primaryOperator === senderId) {
          return exitDesktopMutation({ status: "refused", reason: "primary-removal" });
        }
        if (!base.allowFrom.includes(senderId)) {
          return exitDesktopMutation({ status: "not-found" });
        }

        const { [senderId]: _removed, ...addedAt } = base.addedAt ?? {};
        result = { status: "removed" };
        return {
          ...base,
          allowFrom: base.allowFrom.filter((id) => id !== senderId),
          addedAt,
        };
      },
      true,
    );
  } catch (err) {
    if (err instanceof DesktopSenderMutationExit) {
      return err.result as RemoveSecondarySenderResult;
    }
    if (err instanceof AllowedSendersCommitUncertainError) {
      return { status: "uncertain" };
    }
    throw err;
  }

  return result as RemoveSecondarySenderResult;
}

export function listDesktopAllowedSenders(dataDir: string): DesktopAllowedSender[] {
  const state = loadAllowedSendersFromFile(dataDir);
  return state.allowFrom.map((senderId) => desktopSender(state, senderId));
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
  mutateAllowedSenders(
    dataDir,
    (current) => {
      if (!current) return defaultPairingState();
      if (!current.allowFrom.includes(senderId)) return current;
      const filtered = current.allowFrom.filter((id) => id !== senderId);
      const { [senderId]: _dropped, ...remainingAddedAt } = current.addedAt;
      return {
        ...current,
        allowFrom: filtered,
        addedAt: remainingAddedAt,
        dmPolicy: filtered.length === 0 ? "pairing" : current.dmPolicy,
        primaryOperator: current.primaryOperator === senderId ? null : current.primaryOperator,
      };
    },
    true,
  );
}
