import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  link as fsLink,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isMap, parseDocument, type Document, type ParsedNode } from "yaml";

export const LEGACY_MIGRATION_SCHEMA_VERSION = 1 as const;
export const LEGACY_MIGRATION_ID = "legacy-home-v1" as const;
export const LEGACY_MIGRATION_CONTROL_RELATIVE = "config/migrations/legacy-home-v1" as const;
export const LEGACY_MIGRATION_NON_TTY_REFUSAL_EXIT_CODE = 2 as const;

export type LegacyMigrationAction =
  | { readonly kind: "resume"; readonly isTTY: boolean }
  | { readonly kind: "confirm"; readonly manifestDigest: string }
  | { readonly kind: "discard"; readonly manifestDigest: string }
  | { readonly kind: "replan"; readonly discardedManifestDigest: string; readonly isTTY: boolean };

export interface LegacyMigrationOptions {
  readonly sourceRoot: string;
  readonly targetRoot: string;
  readonly action: LegacyMigrationAction;
}

export type LegacyMigrationCheckpoint =
  | "before-journal-rename"
  | "after-journal-rename"
  | "before-payload-publication"
  | "after-payload-checkpoint"
  | "after-discard-archive-link"
  | "after-discard-journal-unlink";

export interface LegacyMigrationCheckpointContext {
  readonly checkpoint: LegacyMigrationCheckpoint;
  readonly journalState: "planned" | "copying" | "verified" | "done";
  readonly revision: number;
  readonly entryId: string | null;
  readonly copiedCount: number;
}

export interface LegacyMigrationDependencies {
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly link?: (existingPath: string, newPath: string) => Promise<void>;
  readonly checkpoint?: (context: LegacyMigrationCheckpointContext) => void | Promise<void>;
}

export type LegacyMigrationRefusalCode =
  | "confirmation-required"
  | "pinned-refusal"
  | "manifest-mismatch"
  | "invalid-action"
  | "invalid-source-config"
  | "unsupported-data-dir"
  | "unsupported-credential-layout"
  | "source-target-overlap"
  | "source-drift"
  | "target-conflict"
  | "target-path-unsafe"
  | "no-clobber-unavailable"
  | "verification-failed"
  | "legacy-mutated-after-cutover";

export type LegacyMigrationResult =
  | {
      readonly status: "not-needed";
      readonly exitCode: 0;
      readonly journalPath: string;
      readonly manifestDigest: null;
    }
  | {
      readonly status: "refused";
      readonly exitCode: 2 | 3 | 4;
      readonly journalPath: string;
      readonly manifestDigest: string | null;
      readonly reason: LegacyMigrationRefusalCode;
      readonly conflictIds: readonly string[];
    }
  | {
      readonly status: "discarded";
      readonly exitCode: 0;
      readonly journalPath: string;
      readonly manifestDigest: string;
      readonly archivePath: string;
    }
  | {
      readonly status: "done";
      readonly exitCode: 0;
      readonly journalPath: string;
      readonly manifestDigest: string;
      readonly completion: "complete" | "partial";
      readonly copiedIds: readonly string[];
      readonly skipVerifiedIds: readonly string[];
      readonly skippedConflictIds: readonly string[];
      readonly freezePoint: string;
    };

type SourceOwner = "legacy-root" | "data-root";
type FileType = "regular" | "symlink" | "other";
type Disposition = "migrate" | "skip" | "defer" | "shadowed" | "refuse";
type Transform = "none" | "config-v1";
type TargetAtPlan = "absent" | "identical" | "conflict" | null;
type JournalState = "planned" | "copying" | "verified" | "done";

interface LegacyMigrationManifestEntry {
  id: string;
  sourceOwner: SourceOwner;
  sourcePath: string;
  sourceRelativePath: string;
  fileType: FileType;
  disposition: Disposition;
  reason: string;
  targetRelativePath: string | null;
  transform: Transform;
  sourceSha256: string | null;
  outputSha256: string | null;
  sourceBytes: number | null;
  outputBytes: number | null;
  sourceMode: number | null;
  symlinkTarget: string | null;
  targetAtPlan: TargetAtPlan;
  targetActualSha256: string | null;
  requiresConfirmation: boolean;
}

interface LegacyMigrationManifest {
  schemaVersion: 1;
  migrationId: "legacy-home-v1";
  sourceRoot: string;
  dataRoot: string;
  targetRoot: string;
  entries: LegacyMigrationManifestEntry[];
}

interface JournalHistory {
  revision: number;
  state: JournalState;
  at: string;
}

interface JournalRefusal {
  code: LegacyMigrationRefusalCode;
  entryIds: string[];
  expectedHashes: Array<string | null>;
  actualHashes: Array<string | null>;
}

interface VerificationOutput {
  entryId: string;
  expectedSha256: string;
  actualSha256: string | null;
  matches: boolean;
}

interface LegacyMigrationJournal {
  schemaVersion: 1;
  migrationId: "legacy-home-v1";
  sourceRoot: string;
  dataRoot: string;
  targetRoot: string;
  manifestDigest: string;
  manifest: LegacyMigrationManifest;
  state: JournalState;
  revision: number;
  history: JournalHistory[];
  results: {
    copiedIds: string[];
    skipVerifiedIds: string[];
    skippedConflictIds: string[];
  };
  refusal: JournalRefusal | null;
  verification: {
    complete: boolean;
    allMatch: boolean;
    outputs: VerificationOutput[];
  };
  completion: "pending" | "complete" | "partial";
  freezePoint: string | null;
}

interface Dependencies {
  now: () => Date;
  randomId: () => string;
  link: (existingPath: string, newPath: string) => Promise<void>;
  checkpoint: (context: LegacyMigrationCheckpointContext) => void | Promise<void>;
}

interface ConfigPlan {
  bytes: Buffer;
  output: Buffer;
  dataRoot: string;
  provider: unknown;
  authProfile: unknown;
  sourcePresent: boolean;
}

interface InventoryBuild {
  manifest: LegacyMigrationManifest;
  digest: string;
}

interface SourceDifference {
  ids: string[];
  expected: Array<string | null>;
  actual: Array<string | null>;
  hasAddition: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const JOURNAL_KEYS = [
  "completion",
  "dataRoot",
  "freezePoint",
  "history",
  "manifest",
  "manifestDigest",
  "migrationId",
  "refusal",
  "results",
  "revision",
  "schemaVersion",
  "sourceRoot",
  "state",
  "targetRoot",
  "verification",
] as const;
const ENTRY_KEYS = [
  "disposition",
  "fileType",
  "id",
  "outputBytes",
  "outputSha256",
  "reason",
  "requiresConfirmation",
  "sourceBytes",
  "sourceMode",
  "sourceOwner",
  "sourcePath",
  "sourceRelativePath",
  "sourceSha256",
  "symlinkTarget",
  "targetActualSha256",
  "targetAtPlan",
  "targetRelativePath",
  "transform",
] as const;

class PlanningRefusal extends Error {
  constructor(
    readonly code: LegacyMigrationRefusalCode,
    readonly exitCode: 2 | 3 | 4,
  ) {
    super(code);
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort(compareCodeUnits)
      .map((key) => {
        const child = value[key];
        if (child === undefined) throw new TypeError("Canonical JSON forbids undefined");
        return `${JSON.stringify(key)}:${canonicalize(child)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError("Canonical JSON contains an unsupported value");
}

function validatedRandomId(randomId: () => string): string {
  const value = randomId();
  if (!UUID_PATTERN.test(value)) throw new TypeError("randomId must return an RFC 4122 UUID");
  return value;
}

function errorCode(error: unknown): string | undefined {
  return isObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function hardLinksUnsupported(error: unknown): boolean {
  return ["EXDEV", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EPERM"].includes(errorCode(error) ?? "");
}

async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function readRegularNoFollow(
  path: string,
  expected?: Stats,
): Promise<{ bytes: Buffer; stat: Stats }> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("not a regular file");
    if (expected !== undefined && (stat.dev !== expected.dev || stat.ino !== expected.ino))
      throw new Error("file identity changed");
    const bytes = await handle.readFile();
    return { bytes, stat };
  } finally {
    await handle?.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function pathContains(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return (
    difference === "" ||
    (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference))
  );
}

async function physicalPath(path: string): Promise<string> {
  const suffix: string[] = [];
  let cursor = path;
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...suffix.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
}

async function rootsOverlap(a: string, b: string): Promise<boolean> {
  if (pathContains(a, b) || pathContains(b, a)) return true;
  const [physicalA, physicalB] = await Promise.all([physicalPath(a), physicalPath(b)]);
  return pathContains(physicalA, physicalB) || pathContains(physicalB, physicalA);
}

function refusal(
  journalPath: string,
  reason: LegacyMigrationRefusalCode,
  exitCode: 2 | 3 | 4,
  manifestDigest: string | null,
  conflictIds: readonly string[] = [],
): LegacyMigrationResult {
  return { status: "refused", exitCode, journalPath, manifestDigest, reason, conflictIds };
}

function validAction(action: unknown): action is LegacyMigrationAction {
  if (!isObject(action) || typeof action.kind !== "string") return false;
  if (action.kind === "resume")
    return hasExactKeys(action, ["isTTY", "kind"]) && typeof action.isTTY === "boolean";
  if (action.kind === "confirm" || action.kind === "discard")
    return (
      hasExactKeys(action, ["kind", "manifestDigest"]) && typeof action.manifestDigest === "string"
    );
  if (action.kind === "replan")
    return (
      hasExactKeys(action, ["discardedManifestDigest", "isTTY", "kind"]) &&
      typeof action.discardedManifestDigest === "string" &&
      typeof action.isTTY === "boolean"
    );
  return false;
}

function privateDirectoryMode(stat: Stats): boolean {
  return (stat.mode & 0o7777 & ~0o700) === 0;
}

function privateFileMode(stat: Stats): boolean {
  return (stat.mode & 0o7777 & ~0o600) === 0;
}

async function ensureSafeTargetDirectory(
  requestedPath: string,
  targetRoot: string,
  create: boolean,
): Promise<boolean> {
  if (!pathContains(targetRoot, requestedPath)) return false;
  const parsedRoot = resolve(sep);
  const components = resolve(requestedPath).slice(parsedRoot.length).split(sep).filter(Boolean);
  let cursor = parsedRoot;
  let belowTarget = cursor === targetRoot;
  for (const component of components) {
    cursor = join(cursor, component);
    if (cursor === targetRoot) belowTarget = true;
    let stat = await lstatOrNull(cursor);
    if (stat === null) {
      if (!belowTarget || !create) return !belowTarget ? false : true;
      let created = false;
      try {
        await mkdir(cursor, 0o700);
        created = true;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      stat = await lstatOrNull(cursor);
      if (created && stat !== null && stat.isDirectory() && !stat.isSymbolicLink()) {
        const handle = await open(
          cursor,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
        );
        try {
          const opened = await handle.stat();
          if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino)
            return false;
          await handle.chmod(0o700);
        } finally {
          await handle.close();
        }
        stat = await lstatOrNull(cursor);
      }
    }
    if (stat === null || !stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (belowTarget && !privateDirectoryMode(stat)) return false;
  }
  return true;
}

function normalizeRelative(path: string): string {
  return path.split(sep).join("/");
}

function safeRelativeTarget(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || path.includes("\\"))
    return false;
  const segments = path.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function parseConfig(bytes: Buffer, sourceRoot: string, targetRoot: string): ConfigPlan {
  let document: Document.Parsed<ParsedNode>;
  try {
    document = parseDocument(bytes.toString("utf8"), { uniqueKeys: true });
  } catch {
    throw new PlanningRefusal("invalid-source-config", 4);
  }
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new PlanningRefusal("invalid-source-config", 4);
  }
  const rawDataRoot = document.get("data_dir");
  let dataRoot = sourceRoot;
  if (rawDataRoot !== undefined) {
    if (
      typeof rawDataRoot !== "string" ||
      rawDataRoot.length === 0 ||
      rawDataRoot.startsWith("~/") ||
      !isAbsolute(rawDataRoot)
    ) {
      throw new PlanningRefusal("unsupported-data-dir", 4);
    }
    dataRoot = resolve(rawDataRoot);
  }
  let output: Buffer;
  let provider: unknown;
  let authProfile: unknown;
  try {
    const llm = document.get("llm", true);
    if (isMap(llm)) {
      provider = llm.get("provider");
      authProfile = llm.get("auth_profile");
    }
    document.set("data_dir", targetRoot);
    const telegram = document.get("telegram", true);
    if (isMap(telegram)) telegram.delete("bot_token");
    output = Buffer.from(String(document), "utf8");
  } catch {
    throw new PlanningRefusal("invalid-source-config", 4);
  }
  return { bytes, output, dataRoot, provider, authProfile, sourcePresent: true };
}

function validOAuthProfiles(bytes: Buffer): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  for (const value of Object.values(parsed)) {
    if (!isObject(value)) return null;
    const allowed = new Set(["type", "access", "refresh", "expires", "accountId", "email"]);
    if (Object.keys(value).some((key) => !allowed.has(key))) return null;
    if (
      value.type !== "oauth" ||
      typeof value.access !== "string" ||
      typeof value.refresh !== "string" ||
      typeof value.expires !== "number" ||
      !Number.isFinite(value.expires) ||
      (value.accountId !== undefined && typeof value.accountId !== "string") ||
      (value.email !== undefined && typeof value.email !== "string")
    ) {
      return null;
    }
    const required = ["type", "access", "refresh", "expires"];
    if (required.some((key) => !Object.hasOwn(value, key))) return null;
  }
  return parsed;
}

function routeLeaf(
  sourceOwner: SourceOwner,
  sourceRelativePath: string,
  sourcePath: string,
  fileType: FileType,
  sourceRoot: string,
  dataRoot: string,
): Pick<
  LegacyMigrationManifestEntry,
  "disposition" | "reason" | "targetRelativePath" | "transform"
> {
  const sourceRelative = normalizeRelative(relative(sourceRoot, sourcePath));
  const dataRelative = normalizeRelative(relative(dataRoot, sourcePath));
  const underSource = pathContains(sourceRoot, sourcePath);
  const underData = pathContains(dataRoot, sourcePath);

  if (underSource && sourceRelative === "config.yaml") {
    return {
      disposition: "migrate",
      reason: "config-v1",
      targetRelativePath: "config/config.yaml",
      transform: "config-v1",
    };
  }
  if (underSource && sourceRelative === "auth-profiles.json") {
    return {
      disposition: "migrate",
      reason: "oauth-profile",
      targetRelativePath: "config/auth-profiles.json",
      transform: "none",
    };
  }
  if (
    underSource &&
    (sourceRelative === "auth/codex" || sourceRelative.startsWith("auth/codex/"))
  ) {
    return {
      disposition: "refuse",
      reason: "unsupported-credential-layout",
      targetRelativePath: null,
      transform: "none",
    };
  }
  if (underData && dataRelative === "memory/MEMORY.md") {
    return {
      disposition: "migrate",
      reason: "memory",
      targetRelativePath: "memory/MEMORY.md",
      transform: "none",
    };
  }
  if (underData && /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(dataRelative)) {
    return {
      disposition: "migrate",
      reason: "daily-note",
      targetRelativePath: dataRelative,
      transform: "none",
    };
  }
  if (underData && dataRelative === "memory/MEMORY.history.jsonl") {
    return {
      disposition: "migrate",
      reason: "memory-history",
      targetRelativePath: dataRelative,
      transform: "none",
    };
  }
  if (underData && dataRelative === "memory/events.jsonl") {
    return {
      disposition: "migrate",
      reason: "event-ledger",
      targetRelativePath: dataRelative,
      transform: "none",
    };
  }
  if (underData && dataRelative === "plans/current-plan.json") {
    return {
      disposition: "migrate",
      reason: "current-plan",
      targetRelativePath: dataRelative,
      transform: "none",
    };
  }
  if (
    dataRoot !== sourceRoot &&
    sourceOwner === "legacy-root" &&
    underSource &&
    (sourceRelative.startsWith("memory/") || sourceRelative.startsWith("plans/"))
  ) {
    return {
      disposition: "shadowed",
      reason: "shadowed-by-authoritative-data-dir",
      targetRelativePath: null,
      transform: "none",
    };
  }
  if (underData && dataRelative === "allowed-senders.json") {
    return {
      disposition: "defer",
      reason: "telegram-guided-import",
      targetRelativePath: null,
      transform: "none",
    };
  }
  if (underData && dataRelative === ".allowed-senders.lock") {
    return {
      disposition: "skip",
      reason: "transient-allowlist-lock",
      targetRelativePath: null,
      transform: "none",
    };
  }
  if (
    underData &&
    /^sessions\/telegram:[^/]*\.jsonl(?:\.(?:reset|precompact|corrupt)\..+|\.tmp)?$/.test(
      dataRelative,
    )
  ) {
    return {
      disposition: "defer",
      reason: "telegram-channel-state",
      targetRelativePath: null,
      transform: "none",
    };
  }
  if (underData && dataRelative.startsWith("sessions/")) {
    return {
      disposition: "skip",
      reason: "fresh-cli-session",
      targetRelativePath: null,
      transform: "none",
    };
  }
  if (underData && dataRelative.startsWith("data/")) {
    return {
      disposition: "skip",
      reason: "re-derivable",
      targetRelativePath: null,
      transform: "none",
    };
  }
  if (
    underData &&
    (dataRelative.startsWith("logs/") || dataRelative.startsWith("usage-ledger.jsonl"))
  ) {
    return {
      disposition: "skip",
      reason: "diagnostic",
      targetRelativePath: null,
      transform: "none",
    };
  }
  if (
    underData &&
    ["instance-id", "last-notified-version", "last-run.json"].includes(dataRelative)
  ) {
    return {
      disposition: "skip",
      reason: "machine-local",
      targetRelativePath: null,
      transform: "none",
    };
  }
  const reserved = (path: string) =>
    ["store/", "archive/", "config/"].some((prefix) => path.startsWith(prefix));
  if ((underSource && reserved(sourceRelative)) || (underData && reserved(dataRelative))) {
    return {
      disposition: "skip",
      reason: "reserved-namespace",
      targetRelativePath: null,
      transform: "none",
    };
  }
  if (fileType === "symlink") {
    return { disposition: "skip", reason: "symlink", targetRelativePath: null, transform: "none" };
  }
  if (fileType === "other") {
    return {
      disposition: "skip",
      reason: "unsupported-leaf-type",
      targetRelativePath: null,
      transform: "none",
    };
  }
  void sourceRelativePath;
  return {
    disposition: "skip",
    reason: "unrecognized",
    targetRelativePath: null,
    transform: "none",
  };
}

function entryIdentity(entry: LegacyMigrationManifestEntry): string {
  return sha256(
    canonicalize({
      sourceOwner: entry.sourceOwner,
      sourcePath: entry.sourcePath,
      targetRelativePath: entry.targetRelativePath,
      disposition: entry.disposition,
      reason: entry.reason,
      sourceSha256: entry.sourceSha256,
      outputSha256: entry.outputSha256,
    }),
  );
}

async function walkLeaves(
  root: string,
  owner: SourceOwner,
  prunePhysicalRoot: string | null,
  visit: (path: string, owner: SourceOwner, relativePath: string, stat: Stats) => Promise<void>,
): Promise<void> {
  const rootStat = await lstatOrNull(root);
  if (rootStat === null) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    await visit(root, owner, "", rootStat);
    return;
  }
  async function descend(directory: string): Promise<void> {
    const names = (await readdir(directory)).sort(compareCodeUnits);
    for (const name of names) {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (prunePhysicalRoot !== null) {
          let physical: string;
          try {
            physical = await realpath(path);
          } catch {
            throw new PlanningRefusal("source-drift", 3);
          }
          if (physical === prunePhysicalRoot) continue;
        }
        await descend(path);
      } else {
        await visit(path, owner, normalizeRelative(relative(root, path)), stat);
      }
    }
  }
  await descend(root);
}

async function sourceInventory(
  sourceRoot: string,
  dataRoot: string,
  targetRoot: string,
  configPlan: ConfigPlan,
  authBytes: Buffer | null,
): Promise<LegacyMigrationManifestEntry[]> {
  const entries: LegacyMigrationManifestEntry[] = [];
  const sourcePhysical = await physicalPath(sourceRoot);
  const dataPhysical = await physicalPath(dataRoot);
  const physicalEqual = sourcePhysical === dataPhysical;
  const dataInsideSource = !physicalEqual && pathContains(sourcePhysical, dataPhysical);
  const sourceInsideData = !physicalEqual && pathContains(dataPhysical, sourcePhysical);

  const visit = async (
    path: string,
    owner: SourceOwner,
    sourceRelativePath: string,
    stat: Stats,
  ): Promise<void> => {
    const fileType: FileType = stat.isFile()
      ? "regular"
      : stat.isSymbolicLink()
        ? "symlink"
        : "other";
    if (path === join(sourceRoot, "config.yaml") && !configPlan.sourcePresent)
      throw new PlanningRefusal("source-drift", 3);
    const route = routeLeaf(
      owner,
      sourceRelativePath,
      path,
      fileType,
      sourceRoot,
      physicalEqual ? sourceRoot : dataRoot,
    );
    let bytes: Buffer | null = null;
    let symlinkTarget: string | null = null;
    if (fileType === "regular") {
      if (path === join(sourceRoot, "config.yaml")) bytes = configPlan.bytes;
      else if (path === join(sourceRoot, "auth-profiles.json") && authBytes !== null)
        bytes = authBytes;
      else {
        try {
          bytes = (await readRegularNoFollow(path, stat)).bytes;
        } catch {
          throw new PlanningRefusal("source-drift", 3);
        }
      }
    } else if (fileType === "symlink") {
      symlinkTarget = await readlink(path);
      bytes = Buffer.from(symlinkTarget, "utf8");
    }
    const output =
      route.transform === "config-v1"
        ? configPlan.output
        : route.disposition === "migrate"
          ? bytes
          : null;
    const entry: LegacyMigrationManifestEntry = {
      id: "",
      sourceOwner: owner,
      sourcePath: resolve(path),
      sourceRelativePath,
      fileType,
      ...route,
      sourceSha256: bytes === null ? null : sha256(bytes),
      outputSha256: output === null ? null : sha256(output),
      sourceBytes: bytes === null ? null : bytes.length,
      outputBytes: output === null ? null : output.length,
      sourceMode: stat.mode & 0o7777,
      symlinkTarget,
      targetAtPlan: null,
      targetActualSha256: null,
      requiresConfirmation: false,
    };
    entries.push(entry);
  };

  if (physicalEqual) {
    await walkLeaves(sourceRoot, "legacy-root", null, visit);
  } else {
    await walkLeaves(sourceRoot, "legacy-root", dataInsideSource ? dataPhysical : null, visit);
    await walkLeaves(dataRoot, "data-root", sourceInsideData ? sourcePhysical : null, visit);
  }
  entries.sort(
    (a, b) =>
      compareCodeUnits(a.sourcePath, b.sourcePath) ||
      compareCodeUnits(a.sourceOwner, b.sourceOwner),
  );
  return entries;
}

async function inspectTarget(
  entry: LegacyMigrationManifestEntry,
  targetRoot: string,
): Promise<void> {
  if (
    entry.disposition !== "migrate" ||
    entry.targetRelativePath === null ||
    entry.outputSha256 === null
  )
    return;
  const target = join(targetRoot, ...entry.targetRelativePath.split("/"));
  const safeParent = await ensureSafeTargetDirectory(dirname(target), targetRoot, false);
  const parentStat = await lstatOrNull(dirname(target));
  if (!safeParent && parentStat !== null) throw new PlanningRefusal("target-path-unsafe", 3);
  const stat = await lstatOrNull(target);
  if (stat === null) {
    entry.targetAtPlan = "absent";
    entry.id = entryIdentity(entry);
    return;
  }
  let actual: string | null = null;
  if (stat.isFile() && !stat.isSymbolicLink()) {
    try {
      actual = sha256((await readRegularNoFollow(target, stat)).bytes);
    } catch {
      actual = null;
    }
  }
  if (actual === entry.outputSha256) {
    entry.targetAtPlan = "identical";
    entry.targetActualSha256 = actual;
  } else {
    entry.disposition = "skip";
    entry.reason = "target-conflict";
    entry.targetAtPlan = "conflict";
    entry.targetActualSha256 = actual;
    entry.requiresConfirmation = true;
  }
  entry.id = entryIdentity(entry);
}

async function makeInventory(
  sourceRoot: string,
  dataRoot: string,
  targetRoot: string,
  configPlan: ConfigPlan,
  authBytes: Buffer | null,
  preflight: boolean,
): Promise<InventoryBuild> {
  const entries = await sourceInventory(sourceRoot, dataRoot, targetRoot, configPlan, authBytes);
  for (const entry of entries) {
    if (preflight) await inspectTarget(entry, targetRoot);
    if (entry.id === "") entry.id = entryIdentity(entry);
  }
  const manifest: LegacyMigrationManifest = {
    schemaVersion: LEGACY_MIGRATION_SCHEMA_VERSION,
    migrationId: LEGACY_MIGRATION_ID,
    sourceRoot,
    dataRoot,
    targetRoot,
    entries,
  };
  return { manifest, digest: sha256(canonicalize(manifest)) };
}

function sourceFields(entry: LegacyMigrationManifestEntry): unknown {
  const disposition = entry.reason === "target-conflict" ? "migrate" : entry.disposition;
  const reason =
    entry.reason === "target-conflict"
      ? routeReasonForConflict(entry.targetRelativePath)
      : entry.reason;
  return {
    sourceOwner: entry.sourceOwner,
    sourcePath: entry.sourcePath,
    sourceRelativePath: entry.sourceRelativePath,
    fileType: entry.fileType,
    disposition,
    reason,
    targetRelativePath: entry.targetRelativePath,
    transform: entry.transform,
    sourceSha256: entry.sourceSha256,
    outputSha256: entry.outputSha256,
    sourceBytes: entry.sourceBytes,
    outputBytes: entry.outputBytes,
    sourceMode: entry.sourceMode,
    symlinkTarget: entry.symlinkTarget,
  };
}

function routeReasonForConflict(targetRelativePath: string | null): string {
  if (targetRelativePath === "config/config.yaml") return "config-v1";
  if (targetRelativePath === "config/auth-profiles.json") return "oauth-profile";
  if (targetRelativePath === "memory/MEMORY.md") return "memory";
  if (targetRelativePath === "memory/MEMORY.history.jsonl") return "memory-history";
  if (targetRelativePath === "memory/events.jsonl") return "event-ledger";
  if (targetRelativePath === "plans/current-plan.json") return "current-plan";
  if (targetRelativePath !== null && /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(targetRelativePath))
    return "daily-note";
  return "target-conflict";
}

function sourceDifference(
  pinned: LegacyMigrationManifest,
  current: LegacyMigrationManifest,
): SourceDifference | null {
  const pinnedByPath = new Map(
    pinned.entries.map((entry) => [`${entry.sourcePath}\0${entry.sourceOwner}`, entry]),
  );
  const currentByPath = new Map(
    current.entries.map((entry) => [`${entry.sourcePath}\0${entry.sourceOwner}`, entry]),
  );
  const ids: string[] = [];
  const expected: Array<string | null> = [];
  const actual: Array<string | null> = [];
  for (const entry of pinned.entries) {
    const key = `${entry.sourcePath}\0${entry.sourceOwner}`;
    const other = currentByPath.get(key);
    if (
      other === undefined ||
      canonicalize(sourceFields(entry)) !== canonicalize(sourceFields(other))
    ) {
      ids.push(entry.id);
      expected.push(entry.sourceSha256);
      actual.push(other?.sourceSha256 ?? null);
    }
  }
  const hasAddition = [...currentByPath.keys()].some((key) => !pinnedByPath.has(key));
  return ids.length > 0 || hasAddition ? { ids, expected, actual, hasAddition } : null;
}

function entryValid(value: unknown): value is LegacyMigrationManifestEntry {
  if (!isObject(value) || !hasExactKeys(value, ENTRY_KEYS)) return false;
  if (
    typeof value.id !== "string" ||
    !HASH_PATTERN.test(value.id) ||
    !["legacy-root", "data-root"].includes(String(value.sourceOwner)) ||
    typeof value.sourcePath !== "string" ||
    !isAbsolute(value.sourcePath) ||
    resolve(value.sourcePath) !== value.sourcePath ||
    typeof value.sourceRelativePath !== "string" ||
    value.sourceRelativePath.includes("\\") ||
    value.sourceRelativePath.split("/").some((part) => part === "." || part === "..") ||
    !["regular", "symlink", "other"].includes(String(value.fileType)) ||
    !["migrate", "skip", "defer", "shadowed", "refuse"].includes(String(value.disposition)) ||
    typeof value.reason !== "string" ||
    !(value.targetRelativePath === null || safeRelativeTarget(value.targetRelativePath)) ||
    !["none", "config-v1"].includes(String(value.transform)) ||
    !(
      value.sourceSha256 === null ||
      (typeof value.sourceSha256 === "string" && HASH_PATTERN.test(value.sourceSha256))
    ) ||
    !(
      value.outputSha256 === null ||
      (typeof value.outputSha256 === "string" && HASH_PATTERN.test(value.outputSha256))
    ) ||
    !(
      value.sourceBytes === null ||
      (Number.isSafeInteger(value.sourceBytes) && Number(value.sourceBytes) >= 0)
    ) ||
    !(
      value.outputBytes === null ||
      (Number.isSafeInteger(value.outputBytes) && Number(value.outputBytes) >= 0)
    ) ||
    !(
      value.sourceMode === null ||
      (Number.isInteger(value.sourceMode) &&
        Number(value.sourceMode) >= 0 &&
        Number(value.sourceMode) <= 0o7777)
    ) ||
    !(value.symlinkTarget === null || typeof value.symlinkTarget === "string") ||
    ![null, "absent", "identical", "conflict"].includes(value.targetAtPlan as never) ||
    !(
      value.targetActualSha256 === null ||
      (typeof value.targetActualSha256 === "string" && HASH_PATTERN.test(value.targetActualSha256))
    ) ||
    typeof value.requiresConfirmation !== "boolean"
  )
    return false;
  const entry = value as unknown as LegacyMigrationManifestEntry;
  if (entryIdentity(entry) !== entry.id) return false;
  if (
    entry.fileType === "regular" &&
    (entry.sourceSha256 === null || entry.sourceBytes === null || entry.sourceMode === null)
  )
    return false;
  if (
    entry.fileType === "symlink" &&
    (entry.symlinkTarget === null ||
      entry.sourceSha256 === null ||
      entry.sourceBytes === null ||
      entry.sourceMode === null ||
      entry.outputSha256 !== null ||
      entry.outputBytes !== null ||
      entry.transform !== "none")
  )
    return false;
  if (
    entry.fileType === "other" &&
    (entry.sourceSha256 !== null ||
      entry.outputSha256 !== null ||
      entry.sourceBytes !== null ||
      entry.outputBytes !== null ||
      entry.sourceMode === null ||
      entry.symlinkTarget !== null ||
      entry.transform !== "none")
  )
    return false;
  if (entry.disposition === "migrate") {
    if (
      entry.fileType !== "regular" ||
      entry.targetRelativePath === null ||
      entry.outputSha256 === null ||
      entry.outputBytes === null ||
      !["absent", "identical"].includes(entry.targetAtPlan ?? "") ||
      entry.requiresConfirmation
    )
      return false;
    if (entry.targetAtPlan === "absent" && entry.targetActualSha256 !== null) return false;
    if (entry.targetAtPlan === "identical" && entry.targetActualSha256 !== entry.outputSha256)
      return false;
  }
  if (
    entry.reason === "target-conflict" &&
    !(
      entry.fileType === "regular" &&
      entry.disposition === "skip" &&
      entry.targetRelativePath !== null &&
      entry.outputSha256 !== null &&
      entry.outputBytes !== null &&
      entry.targetAtPlan === "conflict" &&
      entry.requiresConfirmation
    )
  )
    return false;
  if (entry.disposition !== "migrate" && entry.reason !== "target-conflict") {
    if (
      entry.outputSha256 !== null ||
      entry.outputBytes !== null ||
      entry.targetRelativePath !== null ||
      entry.targetAtPlan !== null ||
      entry.targetActualSha256 !== null ||
      entry.requiresConfirmation ||
      entry.transform !== "none"
    )
      return false;
  }
  if (entry.transform === "config-v1" && entry.targetRelativePath !== "config/config.yaml")
    return false;
  return true;
}

function orderedSubset(values: unknown, manifestIds: string[]): values is string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) return false;
  const strings = values as string[];
  if (new Set(strings).size !== strings.length) return false;
  const indices = strings.map((id) => manifestIds.indexOf(id));
  return (
    indices.every((index) => index >= 0) &&
    indices.every((index, position) => position === 0 || index > indices[position - 1]!)
  );
}

function parseJournal(
  bytes: Buffer,
  sourceRoot: string,
  targetRoot: string,
): { journal: LegacyMigrationJournal | null; digest: string | null } {
  let parsed: unknown;
  let digest: string | null = null;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
    if (isObject(parsed) && typeof parsed.manifestDigest === "string")
      digest = parsed.manifestDigest;
  } catch {
    return { journal: null, digest };
  }
  if (!isObject(parsed) || !hasExactKeys(parsed, JOURNAL_KEYS)) return { journal: null, digest };
  if (
    parsed.schemaVersion !== 1 ||
    parsed.migrationId !== LEGACY_MIGRATION_ID ||
    parsed.sourceRoot !== sourceRoot ||
    parsed.targetRoot !== targetRoot ||
    typeof parsed.dataRoot !== "string" ||
    !isAbsolute(parsed.dataRoot) ||
    resolve(parsed.dataRoot) !== parsed.dataRoot ||
    typeof parsed.manifestDigest !== "string" ||
    !HASH_PATTERN.test(parsed.manifestDigest) ||
    !["planned", "copying", "verified", "done"].includes(String(parsed.state)) ||
    !Number.isSafeInteger(parsed.revision) ||
    Number(parsed.revision) < 1 ||
    !["pending", "complete", "partial"].includes(String(parsed.completion)) ||
    !(parsed.freezePoint === null || typeof parsed.freezePoint === "string")
  )
    return { journal: null, digest };
  if (
    !isObject(parsed.manifest) ||
    !hasExactKeys(parsed.manifest, [
      "dataRoot",
      "entries",
      "migrationId",
      "schemaVersion",
      "sourceRoot",
      "targetRoot",
    ])
  )
    return { journal: null, digest };
  if (
    parsed.manifest.schemaVersion !== 1 ||
    parsed.manifest.migrationId !== LEGACY_MIGRATION_ID ||
    parsed.manifest.sourceRoot !== sourceRoot ||
    parsed.manifest.dataRoot !== parsed.dataRoot ||
    parsed.manifest.targetRoot !== targetRoot ||
    !Array.isArray(parsed.manifest.entries) ||
    !parsed.manifest.entries.every(entryValid)
  )
    return { journal: null, digest };
  const entries = parsed.manifest.entries as unknown as LegacyMigrationManifestEntry[];
  const sorted = [...entries].sort(
    (a, b) =>
      compareCodeUnits(a.sourcePath, b.sourcePath) ||
      compareCodeUnits(a.sourceOwner, b.sourceOwner),
  );
  if (
    entries.some((entry, index) => entry !== sorted[index]) ||
    new Set(entries.map((entry) => entry.id)).size !== entries.length
  )
    return { journal: null, digest };
  for (const entry of entries) {
    const ownerRoot = entry.sourceOwner === "legacy-root" ? sourceRoot : String(parsed.dataRoot);
    if (
      !pathContains(ownerRoot, entry.sourcePath) ||
      normalizeRelative(relative(ownerRoot, entry.sourcePath)) !== entry.sourceRelativePath
    )
      return { journal: null, digest };
  }
  if (sha256(canonicalize(parsed.manifest)) !== parsed.manifestDigest)
    return { journal: null, digest };
  const revision = Number(parsed.revision);
  if (!Array.isArray(parsed.history) || parsed.history.length !== revision)
    return { journal: null, digest };
  const stateOrder: Record<JournalState, number> = { planned: 0, copying: 1, verified: 2, done: 3 };
  let previousState = -1;
  for (let index = 0; index < parsed.history.length; index++) {
    const row = parsed.history[index];
    if (
      !isObject(row) ||
      !hasExactKeys(row, ["at", "revision", "state"]) ||
      row.revision !== index + 1 ||
      !["planned", "copying", "verified", "done"].includes(String(row.state)) ||
      typeof row.at !== "string"
    )
      return { journal: null, digest };
    try {
      if (new Date(row.at).toISOString() !== row.at) return { journal: null, digest };
    } catch {
      return { journal: null, digest };
    }
    const order = stateOrder[row.state as JournalState];
    if (order < previousState || (order > previousState + 1 && previousState >= 0))
      return { journal: null, digest };
    previousState = order;
  }
  if ((parsed.history[0] as Record<string, unknown>).state !== "planned")
    return { journal: null, digest };
  if ((parsed.history.at(-1) as Record<string, unknown>).state !== parsed.state)
    return { journal: null, digest };
  const ids = entries.map((entry) => entry.id);
  if (
    !isObject(parsed.results) ||
    !hasExactKeys(parsed.results, ["copiedIds", "skipVerifiedIds", "skippedConflictIds"]) ||
    !orderedSubset(parsed.results.copiedIds, ids) ||
    !orderedSubset(parsed.results.skipVerifiedIds, ids) ||
    !orderedSubset(parsed.results.skippedConflictIds, ids)
  )
    return { journal: null, digest };
  const conflictIds = entries
    .filter((entry) => entry.reason === "target-conflict")
    .map((entry) => entry.id);
  if ((parsed.results.skippedConflictIds as string[]).some((id) => !conflictIds.includes(id)))
    return { journal: null, digest };
  const migrateIds = entries
    .filter((entry) => entry.disposition === "migrate")
    .map((entry) => entry.id);
  if (
    [
      ...(parsed.results.copiedIds as string[]),
      ...(parsed.results.skipVerifiedIds as string[]),
    ].some((id) => !migrateIds.includes(id))
  )
    return { journal: null, digest };
  if (parsed.refusal !== null) {
    if (
      !isObject(parsed.refusal) ||
      !hasExactKeys(parsed.refusal, ["actualHashes", "code", "entryIds", "expectedHashes"]) ||
      ![
        "confirmation-required",
        "pinned-refusal",
        "manifest-mismatch",
        "invalid-action",
        "invalid-source-config",
        "unsupported-data-dir",
        "unsupported-credential-layout",
        "source-target-overlap",
        "source-drift",
        "target-conflict",
        "target-path-unsafe",
        "no-clobber-unavailable",
        "verification-failed",
        "legacy-mutated-after-cutover",
      ].includes(String(parsed.refusal.code)) ||
      !orderedSubset(parsed.refusal.entryIds, ids) ||
      !Array.isArray(parsed.refusal.expectedHashes) ||
      !Array.isArray(parsed.refusal.actualHashes) ||
      parsed.refusal.expectedHashes.length !== parsed.refusal.entryIds.length ||
      parsed.refusal.actualHashes.length !== parsed.refusal.entryIds.length ||
      [...parsed.refusal.expectedHashes, ...parsed.refusal.actualHashes].some(
        (hash) => hash !== null && (typeof hash !== "string" || !HASH_PATTERN.test(hash)),
      )
    )
      return { journal: null, digest };
  }
  if (
    !isObject(parsed.verification) ||
    !hasExactKeys(parsed.verification, ["allMatch", "complete", "outputs"]) ||
    typeof parsed.verification.complete !== "boolean" ||
    typeof parsed.verification.allMatch !== "boolean" ||
    !Array.isArray(parsed.verification.outputs)
  )
    return { journal: null, digest };
  for (const output of parsed.verification.outputs) {
    if (
      !isObject(output) ||
      !hasExactKeys(output, ["actualSha256", "entryId", "expectedSha256", "matches"]) ||
      typeof output.entryId !== "string" ||
      !ids.includes(output.entryId) ||
      typeof output.expectedSha256 !== "string" ||
      !HASH_PATTERN.test(output.expectedSha256) ||
      !(
        output.actualSha256 === null ||
        (typeof output.actualSha256 === "string" && HASH_PATTERN.test(output.actualSha256))
      ) ||
      typeof output.matches !== "boolean" ||
      output.matches !== (output.actualSha256 === output.expectedSha256)
    )
      return { journal: null, digest };
  }
  const outputIds = (parsed.verification.outputs as Array<Record<string, unknown>>).map((output) =>
    String(output.entryId),
  );
  if (
    new Set(outputIds).size !== outputIds.length ||
    outputIds.some((id, index) => id !== migrateIds[index])
  )
    return { journal: null, digest };
  if (parsed.verification.complete && outputIds.length !== migrateIds.length)
    return { journal: null, digest };
  if (
    parsed.verification.complete &&
    parsed.verification.allMatch !==
      parsed.verification.outputs.every(
        (output) => (output as Record<string, unknown>).matches === true,
      )
  )
    return { journal: null, digest };
  if (
    !parsed.verification.complete &&
    (parsed.verification.allMatch || parsed.verification.outputs.length !== 0)
  )
    return { journal: null, digest };
  const state = parsed.state as JournalState;
  if (
    (state === "planned" || state === "copying") &&
    (parsed.freezePoint !== null || parsed.completion !== "pending")
  )
    return { journal: null, digest };
  if (
    (state === "verified" || state === "done") &&
    (typeof parsed.freezePoint !== "string" ||
      parsed.verification.complete !== true ||
      parsed.verification.allMatch !== true)
  )
    return { journal: null, digest };
  if (state === "done" && parsed.completion === "pending") return { journal: null, digest };
  if (state !== "done" && parsed.completion !== "pending") return { journal: null, digest };
  const verifiedAt = (parsed.history as Array<Record<string, unknown>>).find(
    (row) => row.state === "verified",
  )?.at;
  if ((state === "verified" || state === "done") && parsed.freezePoint !== verifiedAt)
    return { journal: null, digest };
  if (state === "done") {
    const expectedCompletion =
      (parsed.results.skippedConflictIds as string[]).length > 0 ? "partial" : "complete";
    if (parsed.completion !== expectedCompletion) return { journal: null, digest };
    if (
      expectedCompletion === "partial" &&
      canonicalize(parsed.results.skippedConflictIds) !== canonicalize(conflictIds)
    )
      return { journal: null, digest };
  }
  return { journal: parsed as unknown as LegacyMigrationJournal, digest };
}

function checkpointContext(
  checkpoint: LegacyMigrationCheckpoint,
  journal: LegacyMigrationJournal,
  entryId: string | null,
): LegacyMigrationCheckpointContext {
  return {
    checkpoint,
    journalState: journal.state,
    revision: journal.revision,
    entryId,
    copiedCount: journal.results.copiedIds.length,
  };
}

async function cleanupJournalTemps(controlRoot: string): Promise<void> {
  // Control files are outside the payload manifest; under the store lock, matching temp siblings are abandoned.
  const pattern = new RegExp(
    `^journal\\.json\\.tmp\\.\\d+\\.${UUID_PATTERN.source.slice(1, -1)}$`,
    "i",
  );
  for (const name of await readdir(controlRoot))
    if (pattern.test(name)) await unlink(join(controlRoot, name));
}

async function allocateTemp(
  directory: string,
  prefix: string,
  dependencies: Dependencies,
): Promise<{ path: string; handle: Awaited<ReturnType<typeof open>> }> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = validatedRandomId(dependencies.randomId);
    const path = join(directory, `${prefix}${id}`);
    try {
      return { path, handle: await open(path, "wx", 0o600) };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to allocate a unique migration temp file");
}

async function writeJournal(
  journalPath: string,
  journal: LegacyMigrationJournal,
  dependencies: Dependencies,
  entryId: string | null = null,
): Promise<void> {
  const controlRoot = dirname(journalPath);
  await cleanupJournalTemps(controlRoot);
  const temp = await allocateTemp(controlRoot, `journal.json.tmp.${process.pid}.`, dependencies);
  try {
    await temp.handle.writeFile(`${JSON.stringify(journal)}\n`, "utf8");
    await temp.handle.chmod(0o600);
    await temp.handle.sync();
  } finally {
    await temp.handle.close();
  }
  await dependencies.checkpoint(checkpointContext("before-journal-rename", journal, entryId));
  await rename(temp.path, journalPath);
  await syncDirectory(controlRoot);
  await dependencies.checkpoint(checkpointContext("after-journal-rename", journal, entryId));
}

function nextJournal(
  journal: LegacyMigrationJournal,
  state: JournalState,
  dependencies: Dependencies,
  mutate?: (draft: LegacyMigrationJournal, at: string) => void,
): LegacyMigrationJournal {
  const at = dependencies.now().toISOString();
  const draft = structuredClone(journal);
  draft.state = state;
  draft.revision += 1;
  draft.history.push({ revision: draft.revision, state, at });
  draft.refusal = null;
  mutate?.(draft, at);
  return draft;
}

function manifestOrder(journal: LegacyMigrationJournal, ids: Iterable<string>): string[] {
  const wanted = new Set(ids);
  return journal.manifest.entries.filter((entry) => wanted.has(entry.id)).map((entry) => entry.id);
}

async function publishRefusal(
  journalPath: string,
  journal: LegacyMigrationJournal,
  dependencies: Dependencies,
  code: LegacyMigrationRefusalCode,
  ids: string[],
  expected: Array<string | null>,
  actual: Array<string | null>,
): Promise<LegacyMigrationJournal> {
  const revised = nextJournal(journal, journal.state, dependencies, (draft) => {
    draft.refusal = { code, entryIds: ids, expectedHashes: expected, actualHashes: actual };
  });
  await writeJournal(journalPath, revised, dependencies, ids[0] ?? null);
  return revised;
}

async function readAndValidateJournal(
  journalPath: string,
  sourceRoot: string,
  targetRoot: string,
): Promise<{
  journal: LegacyMigrationJournal | null;
  digest: string | null;
  exists: boolean;
  unsafe: boolean;
}> {
  const stat = await lstatOrNull(journalPath);
  if (stat === null) return { journal: null, digest: null, exists: false, unsafe: false };
  if (!stat.isFile() || stat.isSymbolicLink() || !privateFileMode(stat))
    return { journal: null, digest: null, exists: true, unsafe: true };
  let bytes: Buffer;
  try {
    bytes = (await readRegularNoFollow(journalPath, stat)).bytes;
  } catch {
    return { journal: null, digest: null, exists: true, unsafe: true };
  }
  const parsed = parseJournal(bytes, sourceRoot, targetRoot);
  if (parsed.journal !== null) {
    try {
      if (await rootsOverlap(parsed.journal.dataRoot, targetRoot))
        return { journal: null, digest: parsed.digest, exists: true, unsafe: false };
      const physicalEqual =
        (await physicalPath(sourceRoot)) === (await physicalPath(parsed.journal.dataRoot));
      const routeDataRoot = physicalEqual ? sourceRoot : parsed.journal.dataRoot;
      for (const entry of parsed.journal.manifest.entries) {
        if (physicalEqual && entry.sourceOwner === "data-root")
          return { journal: null, digest: parsed.digest, exists: true, unsafe: false };
        const routed = routeLeaf(
          entry.sourceOwner,
          entry.sourceRelativePath,
          entry.sourcePath,
          entry.fileType,
          sourceRoot,
          routeDataRoot,
        );
        if (entry.reason === "target-conflict") {
          if (
            routed.disposition !== "migrate" ||
            routed.targetRelativePath !== entry.targetRelativePath ||
            routed.transform !== entry.transform
          )
            return { journal: null, digest: parsed.digest, exists: true, unsafe: false };
        } else if (
          routed.disposition !== entry.disposition ||
          routed.reason !== entry.reason ||
          routed.targetRelativePath !== entry.targetRelativePath ||
          routed.transform !== entry.transform
        ) {
          return { journal: null, digest: parsed.digest, exists: true, unsafe: false };
        }
      }
    } catch {
      return { journal: null, digest: parsed.digest, exists: true, unsafe: false };
    }
  }
  return { ...parsed, exists: true, unsafe: false };
}

async function loadPlanningInputs(
  sourceRoot: string,
  targetRoot: string,
): Promise<{ config: ConfigPlan; authBytes: Buffer | null }> {
  const configPath = join(sourceRoot, "config.yaml");
  const configStat = await lstatOrNull(configPath);
  if (configStat !== null && (!configStat.isFile() || configStat.isSymbolicLink()))
    throw new PlanningRefusal("invalid-source-config", 4);
  let config: ConfigPlan;
  if (configStat === null) {
    config = {
      bytes: Buffer.alloc(0),
      output: Buffer.alloc(0),
      dataRoot: sourceRoot,
      provider: undefined,
      authProfile: undefined,
      sourcePresent: false,
    };
  } else {
    let configBytes: Buffer;
    try {
      configBytes = (await readRegularNoFollow(configPath, configStat)).bytes;
    } catch {
      throw new PlanningRefusal("invalid-source-config", 4);
    }
    config = parseConfig(configBytes, sourceRoot, targetRoot);
  }
  const dataStat = await lstatOrNull(config.dataRoot);
  if (dataStat?.isSymbolicLink()) throw new PlanningRefusal("unsupported-data-dir", 4);
  const authPath = join(sourceRoot, "auth-profiles.json");
  const authStat = await lstatOrNull(authPath);
  let authBytes: Buffer | null = null;
  let profiles: Record<string, unknown> | null = null;
  if (authStat !== null) {
    if (!authStat.isFile() || authStat.isSymbolicLink())
      throw new PlanningRefusal("invalid-source-config", 4);
    try {
      authBytes = (await readRegularNoFollow(authPath, authStat)).bytes;
    } catch {
      throw new PlanningRefusal("invalid-source-config", 4);
    }
    profiles = validOAuthProfiles(authBytes);
    if (profiles === null) throw new PlanningRefusal("invalid-source-config", 4);
  }
  if (config.provider === "openai-codex") {
    const selected =
      typeof config.authProfile === "string" && config.authProfile.length > 0
        ? config.authProfile
        : "openai-codex";
    if (profiles === null || !Object.hasOwn(profiles, selected))
      throw new PlanningRefusal("invalid-source-config", 4);
  }
  return { config, authBytes };
}

async function rebuildForPinned(
  journal: LegacyMigrationJournal,
): Promise<{ inventory: InventoryBuild; difference: SourceDifference | null }> {
  const inputs = await loadPlanningInputs(journal.sourceRoot, journal.targetRoot);
  if (inputs.config.dataRoot !== journal.dataRoot) {
    return {
      inventory: { manifest: { ...journal.manifest, entries: [] }, digest: "" },
      difference: await differenceFromPinnedReads(journal),
    };
  }
  const inventory = await makeInventory(
    journal.sourceRoot,
    journal.dataRoot,
    journal.targetRoot,
    inputs.config,
    inputs.authBytes,
    false,
  );
  return { inventory, difference: sourceDifference(journal.manifest, inventory.manifest) };
}

async function differenceFromPinnedReads(
  journal: LegacyMigrationJournal,
): Promise<SourceDifference> {
  const ids: string[] = [];
  const expected: Array<string | null> = [];
  const actual: Array<string | null> = [];
  for (const entry of journal.manifest.entries) {
    const stat = await lstatOrNull(entry.sourcePath);
    let currentHash: string | null = null;
    let changed = stat === null || (stat.mode & 0o7777) !== entry.sourceMode;
    if (stat !== null) {
      const fileType: FileType = stat.isFile()
        ? "regular"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other";
      changed ||= fileType !== entry.fileType;
      if (fileType === "regular") {
        try {
          currentHash = sha256((await readRegularNoFollow(entry.sourcePath, stat)).bytes);
        } catch {
          changed = true;
        }
      } else if (fileType === "symlink") {
        try {
          currentHash = sha256(Buffer.from(await readlink(entry.sourcePath), "utf8"));
        } catch {
          changed = true;
        }
      }
      changed ||= currentHash !== entry.sourceSha256;
    }
    if (changed) {
      ids.push(entry.id);
      expected.push(entry.sourceSha256);
      actual.push(currentHash);
    }
  }
  return { ids, expected, actual, hasAddition: ids.length === 0 };
}

async function targetHash(path: string): Promise<string | null> {
  const stat = await lstatOrNull(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) return null;
  try {
    return sha256((await readRegularNoFollow(path, stat)).bytes);
  } catch {
    return null;
  }
}

async function verifyTargets(journal: LegacyMigrationJournal): Promise<VerificationOutput[]> {
  const outputs: VerificationOutput[] = [];
  for (const entry of journal.manifest.entries) {
    if (
      entry.disposition !== "migrate" ||
      entry.targetRelativePath === null ||
      entry.outputSha256 === null
    )
      continue;
    const target = join(journal.targetRoot, ...entry.targetRelativePath.split("/"));
    const safe = await ensureSafeTargetDirectory(dirname(target), journal.targetRoot, false);
    const actual = safe ? await targetHash(target) : null;
    outputs.push({
      entryId: entry.id,
      expectedSha256: entry.outputSha256,
      actualSha256: actual,
      matches: actual === entry.outputSha256,
    });
  }
  return outputs;
}

async function currentOutput(
  entry: LegacyMigrationManifestEntry,
  targetRoot: string,
): Promise<{ source: Buffer; output: Buffer } | null> {
  let source: Buffer;
  try {
    source = (await readRegularNoFollow(entry.sourcePath)).bytes;
  } catch {
    return null;
  }
  if (sha256(source) !== entry.sourceSha256) return null;
  if (entry.transform === "config-v1") {
    let transformed: Buffer;
    try {
      transformed = parseConfig(source, dirname(entry.sourcePath), targetRoot).output;
    } catch {
      return null;
    }
    if (sha256(transformed) !== entry.outputSha256) return null;
    return { source, output: transformed };
  }
  return { source, output: source };
}

async function cleanupPayloadTemps(directory: string, basename: string): Promise<void> {
  const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^\\.${escaped}\\.legacy-migration\\.tmp\\.\\d+\\.${UUID_PATTERN.source.slice(1, -1)}$`,
    "i",
  );
  for (const name of await readdir(directory))
    if (pattern.test(name)) await unlink(join(directory, name));
}

async function executePlan(
  journalPath: string,
  initial: LegacyMigrationJournal,
  dependencies: Dependencies,
): Promise<LegacyMigrationResult> {
  let journal = initial;
  const copiedThisCall: string[] = [];
  const skippedThisCall: string[] = [];

  for (const entry of journal.manifest.entries) {
    if (
      entry.disposition !== "migrate" ||
      entry.targetRelativePath === null ||
      entry.outputSha256 === null
    )
      continue;
    const target = join(journal.targetRoot, ...entry.targetRelativePath.split("/"));
    const directory = dirname(target);
    if (!(await ensureSafeTargetDirectory(directory, journal.targetRoot, true))) {
      journal = await publishRefusal(
        journalPath,
        journal,
        dependencies,
        "target-path-unsafe",
        [entry.id],
        [entry.outputSha256],
        [null],
      );
      return refusal(journalPath, "target-path-unsafe", 3, journal.manifestDigest, [entry.id]);
    }
    await cleanupPayloadTemps(directory, target.slice(directory.length + 1));
    const existing = await targetHash(target);
    if (existing === entry.outputSha256) {
      skippedThisCall.push(entry.id);
      journal = nextJournal(journal, "copying", dependencies, (draft) => {
        draft.results.skipVerifiedIds = manifestOrder(draft, [
          ...draft.results.skipVerifiedIds,
          entry.id,
        ]);
      });
      await writeJournal(journalPath, journal, dependencies, entry.id);
      await dependencies.checkpoint(
        checkpointContext("after-payload-checkpoint", journal, entry.id),
      );
      continue;
    }
    if ((await lstatOrNull(target)) !== null) {
      journal = await publishRefusal(
        journalPath,
        journal,
        dependencies,
        "target-conflict",
        [entry.id],
        [entry.outputSha256],
        [existing],
      );
      return refusal(journalPath, "target-conflict", 3, journal.manifestDigest, [entry.id]);
    }
    const bytes = await currentOutput(entry, journal.targetRoot);
    if (bytes === null) {
      journal = await publishRefusal(
        journalPath,
        journal,
        dependencies,
        "source-drift",
        [entry.id],
        [entry.sourceSha256],
        [null],
      );
      return refusal(journalPath, "source-drift", 3, journal.manifestDigest, [entry.id]);
    }
    const basename = target.slice(directory.length + 1);
    const temp = await allocateTemp(
      directory,
      `.${basename}.legacy-migration.tmp.${process.pid}.`,
      dependencies,
    );
    try {
      await temp.handle.writeFile(bytes.output);
      await temp.handle.chmod(0o600);
      await temp.handle.sync();
    } finally {
      await temp.handle.close();
    }
    if ((await targetHash(temp.path)) !== entry.outputSha256) {
      journal = await publishRefusal(
        journalPath,
        journal,
        dependencies,
        "verification-failed",
        [entry.id],
        [entry.outputSha256],
        [await targetHash(temp.path)],
      );
      return refusal(journalPath, "verification-failed", 3, journal.manifestDigest, [entry.id]);
    }
    await dependencies.checkpoint(
      checkpointContext("before-payload-publication", journal, entry.id),
    );
    const checked = await currentOutput(entry, journal.targetRoot);
    if (checked === null) {
      journal = await publishRefusal(
        journalPath,
        journal,
        dependencies,
        "source-drift",
        [entry.id],
        [entry.sourceSha256],
        [null],
      );
      return refusal(journalPath, "source-drift", 3, journal.manifestDigest, [entry.id]);
    }
    try {
      await dependencies.link(temp.path, target);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        const actual = await targetHash(target);
        if (actual !== entry.outputSha256) {
          journal = await publishRefusal(
            journalPath,
            journal,
            dependencies,
            "target-conflict",
            [entry.id],
            [entry.outputSha256],
            [actual],
          );
          return refusal(journalPath, "target-conflict", 3, journal.manifestDigest, [entry.id]);
        }
        skippedThisCall.push(entry.id);
      } else if (hardLinksUnsupported(error)) {
        journal = await publishRefusal(
          journalPath,
          journal,
          dependencies,
          "no-clobber-unavailable",
          [entry.id],
          [entry.outputSha256],
          [null],
        );
        return refusal(journalPath, "no-clobber-unavailable", 3, journal.manifestDigest, [
          entry.id,
        ]);
      } else {
        throw error;
      }
    }
    if ((await lstatOrNull(target)) !== null) {
      await syncDirectory(directory);
      await unlink(temp.path);
      await syncDirectory(directory);
    }
    const publishedHash = await targetHash(target);
    if (publishedHash !== entry.outputSha256) {
      journal = await publishRefusal(
        journalPath,
        journal,
        dependencies,
        "verification-failed",
        [entry.id],
        [entry.outputSha256],
        [publishedHash],
      );
      return refusal(journalPath, "verification-failed", 3, journal.manifestDigest, [entry.id]);
    }
    if (!skippedThisCall.includes(entry.id)) copiedThisCall.push(entry.id);
    journal = nextJournal(journal, "copying", dependencies, (draft) => {
      if (copiedThisCall.includes(entry.id))
        draft.results.copiedIds = manifestOrder(draft, [...draft.results.copiedIds, entry.id]);
      else
        draft.results.skipVerifiedIds = manifestOrder(draft, [
          ...draft.results.skipVerifiedIds,
          entry.id,
        ]);
    });
    await writeJournal(journalPath, journal, dependencies, entry.id);
    await dependencies.checkpoint(checkpointContext("after-payload-checkpoint", journal, entry.id));
  }

  const outputs = await verifyTargets(journal);
  const mismatched = outputs.filter((output) => !output.matches);
  journal = nextJournal(journal, "copying", dependencies, (draft) => {
    draft.verification = { complete: true, allMatch: mismatched.length === 0, outputs };
  });
  await writeJournal(journalPath, journal, dependencies, mismatched[0]?.entryId ?? null);
  if (mismatched.length > 0) {
    journal = await publishRefusal(
      journalPath,
      journal,
      dependencies,
      "verification-failed",
      mismatched.map((item) => item.entryId),
      mismatched.map((item) => item.expectedSha256),
      mismatched.map((item) => item.actualSha256),
    );
    return refusal(
      journalPath,
      "verification-failed",
      3,
      journal.manifestDigest,
      mismatched.map((item) => item.entryId),
    );
  }
  let rebuilt: Awaited<ReturnType<typeof rebuildForPinned>>;
  try {
    rebuilt = await rebuildForPinned(journal);
  } catch (error) {
    if (error instanceof PlanningRefusal) {
      const difference = await differenceFromPinnedReads(journal);
      journal = await publishRefusal(
        journalPath,
        journal,
        dependencies,
        "source-drift",
        difference.ids,
        difference.expected,
        difference.actual,
      );
      return refusal(journalPath, "source-drift", 3, journal.manifestDigest, difference.ids);
    }
    throw error;
  }
  if (rebuilt.difference !== null) {
    journal = await publishRefusal(
      journalPath,
      journal,
      dependencies,
      "source-drift",
      rebuilt.difference.ids,
      rebuilt.difference.expected,
      rebuilt.difference.actual,
    );
    return refusal(journalPath, "source-drift", 3, journal.manifestDigest, rebuilt.difference.ids);
  }
  journal = nextJournal(journal, "verified", dependencies, (draft, at) => {
    draft.verification = { complete: true, allMatch: true, outputs };
    draft.freezePoint = at;
  });
  await writeJournal(journalPath, journal, dependencies);
  const completion = journal.results.skippedConflictIds.length > 0 ? "partial" : "complete";
  journal = nextJournal(journal, "done", dependencies, (draft) => {
    draft.completion = completion;
  });
  await writeJournal(journalPath, journal, dependencies);
  return {
    status: "done",
    exitCode: 0,
    journalPath,
    manifestDigest: journal.manifestDigest,
    completion,
    copiedIds: copiedThisCall,
    skipVerifiedIds: skippedThisCall,
    skippedConflictIds: journal.results.skippedConflictIds,
    freezePoint: journal.freezePoint!,
  };
}

async function finishVerified(
  journalPath: string,
  journal: LegacyMigrationJournal,
  dependencies: Dependencies,
): Promise<LegacyMigrationResult> {
  const completion = journal.results.skippedConflictIds.length > 0 ? "partial" : "complete";
  const done = nextJournal(journal, "done", dependencies, (draft) => {
    draft.completion = completion;
  });
  await writeJournal(journalPath, done, dependencies);
  return rerunDone(journalPath, done);
}

function rerunDone(journalPath: string, journal: LegacyMigrationJournal): LegacyMigrationResult {
  return {
    status: "done",
    exitCode: 0,
    journalPath,
    manifestDigest: journal.manifestDigest,
    completion: journal.completion as "complete" | "partial",
    copiedIds: [],
    skipVerifiedIds: [],
    skippedConflictIds: journal.results.skippedConflictIds,
    freezePoint: journal.freezePoint!,
  };
}

async function discardJournal(
  journalPath: string,
  journal: LegacyMigrationJournal,
  dependencies: Dependencies,
): Promise<LegacyMigrationResult> {
  const controlRoot = dirname(journalPath);
  const archivePath = join(controlRoot, `journal.discarded.${journal.manifestDigest}.json`);
  let linked = false;
  try {
    await dependencies.link(journalPath, archivePath);
    linked = true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      const archiveStat = await lstatOrNull(archivePath);
      if (
        archiveStat === null ||
        !archiveStat.isFile() ||
        archiveStat.isSymbolicLink() ||
        !privateFileMode(archiveStat)
      )
        return refusal(journalPath, "target-path-unsafe", 3, journal.manifestDigest);
      const canonicalStat = await lstat(journalPath);
      const [canonical, archive] = await Promise.all([
        readRegularNoFollow(journalPath, canonicalStat),
        readRegularNoFollow(archivePath, archiveStat),
      ]);
      if (!canonical.bytes.equals(archive.bytes))
        return refusal(journalPath, "invalid-action", 2, journal.manifestDigest);
    } else if (hardLinksUnsupported(error)) {
      const revised = await publishRefusal(
        journalPath,
        journal,
        dependencies,
        "no-clobber-unavailable",
        [],
        [],
        [],
      );
      return refusal(journalPath, "no-clobber-unavailable", 3, revised.manifestDigest);
    } else throw error;
  }
  void linked;
  await syncDirectory(controlRoot);
  await dependencies.checkpoint(checkpointContext("after-discard-archive-link", journal, null));
  await unlink(journalPath);
  await syncDirectory(controlRoot);
  await dependencies.checkpoint(checkpointContext("after-discard-journal-unlink", journal, null));
  return {
    status: "discarded",
    exitCode: 0,
    journalPath,
    manifestDigest: journal.manifestDigest,
    archivePath,
  };
}

async function validateArchive(
  controlRoot: string,
  digest: string,
  sourceRoot: string,
  targetRoot: string,
): Promise<boolean> {
  if (!HASH_PATTERN.test(digest)) return false;
  const path = join(controlRoot, `journal.discarded.${digest}.json`);
  const stat = await lstatOrNull(path);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || !privateFileMode(stat))
    return false;
  let bytes: Buffer;
  try {
    bytes = (await readRegularNoFollow(path, stat)).bytes;
  } catch {
    return false;
  }
  const parsed = parseJournal(bytes, sourceRoot, targetRoot);
  if (
    parsed.journal === null ||
    parsed.journal.manifestDigest !== digest ||
    !["planned", "copying"].includes(parsed.journal.state)
  )
    return false;
  try {
    return !(await rootsOverlap(parsed.journal.dataRoot, targetRoot));
  } catch {
    return false;
  }
}

function initialJournal(
  inventory: InventoryBuild,
  dependencies: Dependencies,
  refusalValue: JournalRefusal | null,
): LegacyMigrationJournal {
  const at = dependencies.now().toISOString();
  return {
    schemaVersion: 1,
    migrationId: LEGACY_MIGRATION_ID,
    sourceRoot: inventory.manifest.sourceRoot,
    dataRoot: inventory.manifest.dataRoot,
    targetRoot: inventory.manifest.targetRoot,
    manifestDigest: inventory.digest,
    manifest: inventory.manifest,
    state: "planned",
    revision: 1,
    history: [{ revision: 1, state: "planned", at }],
    results: { copiedIds: [], skipVerifiedIds: [], skippedConflictIds: [] },
    refusal: refusalValue,
    verification: { complete: false, allMatch: false, outputs: [] },
    completion: "pending",
    freezePoint: null,
  };
}

async function planFresh(
  sourceRoot: string,
  targetRoot: string,
  journalPath: string,
  dependencies: Dependencies,
): Promise<LegacyMigrationResult> {
  const inputs = await loadPlanningInputs(sourceRoot, targetRoot);
  if (await rootsOverlap(inputs.config.dataRoot, targetRoot))
    return refusal(journalPath, "source-target-overlap", 3, null);
  const inventory = await makeInventory(
    sourceRoot,
    inputs.config.dataRoot,
    targetRoot,
    inputs.config,
    inputs.authBytes,
    true,
  );
  const refusing = inventory.manifest.entries.filter((entry) => entry.disposition === "refuse");
  const conflicts = inventory.manifest.entries.filter((entry) => entry.requiresConfirmation);
  let plannedRefusal: JournalRefusal | null = null;
  if (refusing.length > 0)
    plannedRefusal = {
      code: "unsupported-credential-layout",
      entryIds: refusing.map((entry) => entry.id),
      expectedHashes: refusing.map(() => null),
      actualHashes: refusing.map(() => null),
    };
  else if (conflicts.length > 0)
    plannedRefusal = {
      code: "confirmation-required",
      entryIds: conflicts.map((entry) => entry.id),
      expectedHashes: conflicts.map((entry) => entry.outputSha256),
      actualHashes: conflicts.map((entry) => entry.targetActualSha256),
    };
  if (!(await ensureSafeTargetDirectory(dirname(journalPath), targetRoot, true)))
    return refusal(journalPath, "target-path-unsafe", 3, null);
  const journal = initialJournal(inventory, dependencies, plannedRefusal);
  await writeJournal(journalPath, journal, dependencies);
  if (refusing.length > 0)
    return refusal(
      journalPath,
      "unsupported-credential-layout",
      4,
      inventory.digest,
      refusing.map((entry) => entry.id),
    );
  if (conflicts.length > 0)
    return refusal(
      journalPath,
      "confirmation-required",
      2,
      inventory.digest,
      conflicts.map((entry) => entry.id),
    );
  return executePlan(journalPath, journal, dependencies);
}

export async function migrateLegacyHomeUnderLock(
  options: LegacyMigrationOptions,
  dependencies?: LegacyMigrationDependencies,
): Promise<LegacyMigrationResult> {
  const rawSource = options.sourceRoot;
  const rawTarget = options.targetRoot;
  const provisionalJournal =
    typeof rawTarget === "string" && rawTarget.length > 0 && isAbsolute(rawTarget)
      ? join(resolve(rawTarget), ...LEGACY_MIGRATION_CONTROL_RELATIVE.split("/"), "journal.json")
      : join(resolve(sep), ...LEGACY_MIGRATION_CONTROL_RELATIVE.split("/"), "journal.json");
  if (
    typeof rawSource !== "string" ||
    rawSource.length === 0 ||
    !isAbsolute(rawSource) ||
    typeof rawTarget !== "string" ||
    rawTarget.length === 0 ||
    !isAbsolute(rawTarget)
  ) {
    return refusal(provisionalJournal, "invalid-action", 2, null);
  }
  if (!validAction(options.action)) return refusal(provisionalJournal, "invalid-action", 2, null);
  const sourceRoot = resolve(rawSource);
  const targetRoot = resolve(rawTarget);
  const controlRoot = join(targetRoot, ...LEGACY_MIGRATION_CONTROL_RELATIVE.split("/"));
  const journalPath = join(controlRoot, "journal.json");
  if (await rootsOverlap(sourceRoot, targetRoot))
    return refusal(journalPath, "source-target-overlap", 3, null);
  const deps: Dependencies = {
    now: dependencies?.now ?? (() => new Date()),
    randomId: dependencies?.randomId ?? (() => randomUUID()),
    link: dependencies?.link ?? ((existingPath, newPath) => fsLink(existingPath, newPath)),
    checkpoint: dependencies?.checkpoint ?? (() => undefined),
  };
  if (!(await ensureSafeTargetDirectory(controlRoot, targetRoot, false))) {
    const targetStat = await lstatOrNull(targetRoot);
    if (targetStat !== null) return refusal(journalPath, "target-path-unsafe", 3, null);
  }
  const existing = await readAndValidateJournal(journalPath, sourceRoot, targetRoot);
  if (existing.unsafe) return refusal(journalPath, "target-path-unsafe", 3, null);
  if (existing.exists && existing.journal === null)
    return refusal(journalPath, "manifest-mismatch", 2, existing.digest);
  if (existing.journal !== null) {
    const journal = existing.journal;
    if (options.action.kind === "confirm" || options.action.kind === "discard") {
      if (options.action.manifestDigest !== journal.manifestDigest)
        return refusal(journalPath, "manifest-mismatch", 2, journal.manifestDigest);
    }
    if (options.action.kind === "replan")
      return refusal(journalPath, "invalid-action", 2, journal.manifestDigest);
    if (options.action.kind === "discard") {
      if (!["planned", "copying"].includes(journal.state))
        return refusal(journalPath, "invalid-action", 2, journal.manifestDigest);
      return discardJournal(journalPath, journal, deps);
    }
    if (options.action.kind === "confirm") {
      const conflicts = journal.manifest.entries.filter(
        (entry) => entry.reason === "target-conflict",
      );
      const refusing = journal.manifest.entries.some((entry) => entry.disposition === "refuse");
      if (journal.state !== "planned" || conflicts.length === 0 || refusing)
        return refusal(journalPath, "invalid-action", 2, journal.manifestDigest);
      const confirmed = nextJournal(journal, "copying", deps, (draft) => {
        draft.results.skippedConflictIds = conflicts.map((entry) => entry.id);
      });
      await writeJournal(journalPath, confirmed, deps);
      return executePlan(journalPath, confirmed, deps);
    }
    if (journal.state === "done") return rerunDone(journalPath, journal);
    if (journal.state === "verified") return finishVerified(journalPath, journal, deps);
    if (journal.state === "planned" && journal.refusal !== null)
      return refusal(
        journalPath,
        "pinned-refusal",
        2,
        journal.manifestDigest,
        journal.refusal.entryIds,
      );
    let rebuilt: Awaited<ReturnType<typeof rebuildForPinned>>;
    try {
      rebuilt = await rebuildForPinned(journal);
    } catch {
      const difference = await differenceFromPinnedReads(journal);
      const revised = await publishRefusal(
        journalPath,
        journal,
        deps,
        "source-drift",
        difference.ids,
        difference.expected,
        difference.actual,
      );
      return refusal(journalPath, "source-drift", 3, revised.manifestDigest, difference.ids);
    }
    if (rebuilt.difference !== null) {
      const revised = await publishRefusal(
        journalPath,
        journal,
        deps,
        "source-drift",
        rebuilt.difference.ids,
        rebuilt.difference.expected,
        rebuilt.difference.actual,
      );
      return refusal(
        journalPath,
        "source-drift",
        3,
        revised.manifestDigest,
        rebuilt.difference.ids,
      );
    }
    return executePlan(journalPath, journal, deps);
  }
  if (options.action.kind === "confirm" || options.action.kind === "discard")
    return refusal(journalPath, "invalid-action", 2, null);
  if (
    options.action.kind === "replan" &&
    !(await validateArchive(
      controlRoot,
      options.action.discardedManifestDigest,
      sourceRoot,
      targetRoot,
    ))
  )
    return refusal(journalPath, "manifest-mismatch", 2, null);
  const sourceStat = await lstatOrNull(sourceRoot);
  if (sourceStat === null)
    return { status: "not-needed", exitCode: 0, journalPath, manifestDigest: null };
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink())
    return refusal(journalPath, "invalid-source-config", 4, null);
  try {
    return await planFresh(sourceRoot, targetRoot, journalPath, deps);
  } catch (error) {
    if (error instanceof PlanningRefusal)
      return refusal(journalPath, error.code, error.exitCode, null);
    throw error;
  }
}
