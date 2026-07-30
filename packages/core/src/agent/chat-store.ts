import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  copyFileSync,
  existsSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { ChatLineage } from "@enduragent/engine";
import { messageText } from "@enduragent/engine/sport";
import {
  UNKNOWN_PROVENANCE,
  getMessageProvenance,
  isSourceProvenance,
  setMessageProvenance,
  type SourceProvenance,
} from "../provenance.js";

const MS_PER_DAY = 86_400_000;

// Recorded in history when a turn fails before producing a reply, so the
// athlete's (durably persisted) message is visibly unanswered rather than
// silently dangling.
export const TURN_FAILURE_MARKER =
  "[This turn did not complete — the message above was not answered.]";

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface ChatStoreHooks {
  readonly syncFile?: (descriptor: number) => void;
  readonly syncDirectory?: (descriptor: number) => void;
}

interface DurableChatReset {
  readonly resetId: string;
  readonly boundaryAt: string;
}

const DURABLE_RESET_OPERATIONS = new WeakMap<
  ChatStore,
  (chatId: string, reset: DurableChatReset) => void
>();
const CHAT_STORE_HOOKS = new WeakMap<ChatStore, ChatStoreHooks>();

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function identity(stats: import("node:fs").Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isStrictPrivateDirectory(stats: import("node:fs").Stats): boolean {
  return !stats.isSymbolicLink() && stats.isDirectory() && (stats.mode & 0o7777) === 0o700;
}

function isStrictPrivateFile(stats: import("node:fs").Stats, links: 1 | 2): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isFile() &&
    (stats.mode & 0o7777) === 0o600 &&
    stats.nlink === links
  );
}

function parseArchiveTimestampMs(suffix: string): number | null {
  // archiveAndReset writes toISOString() with ":" replaced by "-"; reverse
  // only the time-part dashes before parsing. Transactional reset archives
  // append a reset ID after the timestamp; it is identity, not time.
  const encodedTimestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)/.exec(suffix)?.[1];
  if (encodedTimestamp === undefined) return null;
  const ms = Date.parse(encodedTimestamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"));
  return Number.isNaN(ms) ? null : ms;
}

interface JsonlLine {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
  templateHash?: string;
  assembledHash?: string;
  provider?: string;
  model?: string;
  lineageVersion?: string;
  provenance?: SourceProvenance;
}

const VALID_ROLES = new Set(["user", "assistant", "system"]);

function parseSessionLine(line: string): JsonlLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.role !== "string" || !VALID_ROLES.has(v.role)) return null;
  if (typeof v.content !== "string" || typeof v.ts !== "string") return null;
  for (const k of [
    "templateHash",
    "assembledHash",
    "provider",
    "model",
    "lineageVersion",
  ] as const) {
    if (k in v && typeof v[k] !== "string") return null;
  }
  if ("provenance" in v && !isSourceProvenance(v.provenance)) {
    return { ...v, provenance: undefined } as JsonlLine;
  }
  return value as JsonlLine;
}

function sameProvenance(left: SourceProvenance, right: SourceProvenance): boolean {
  return (
    left.garmin === right.garmin &&
    left.nonGarmin === right.nonGarmin &&
    left.unknown === right.unknown
  );
}

export class ChatStore {
  private readonly sessionsDir: string;
  private readonly resetArchiveRetentionDays: number;
  private readonly sessionsDirectoryIdentity: FileIdentity;

  constructor(dataDir: string, resetArchiveRetentionDays = 0) {
    this.sessionsDir = join(dataDir, "sessions");
    this.resetArchiveRetentionDays = resetArchiveRetentionDays;
    let created = false;
    try {
      mkdirSync(this.sessionsDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isExists(error)) throw error;
    }

    const beforeOpen = lstatSync(this.sessionsDir);
    if (!isStrictPrivateDirectory(beforeOpen)) {
      throw new Error("Sessions directory is unsafe.");
    }
    const descriptor = openSync(
      this.sessionsDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (created) fchmodSync(descriptor, 0o700);
      const opened = fstatSync(descriptor);
      const afterOpen = lstatSync(this.sessionsDir);
      if (
        !isStrictPrivateDirectory(opened) ||
        !isStrictPrivateDirectory(afterOpen) ||
        !sameIdentity(identity(beforeOpen), identity(opened)) ||
        !sameIdentity(identity(opened), identity(afterOpen))
      ) {
        throw new Error("Sessions directory is unsafe.");
      }
      this.sessionsDirectoryIdentity = identity(opened);
    } finally {
      closeSync(descriptor);
    }

    DURABLE_RESET_OPERATIONS.set(this, (chatId, reset) => {
      const path = this.filePath(chatId);
      const ts = reset.boundaryAt.replace(/:/g, "-");
      const archivePath = `${path}.reset.${ts}.${reset.resetId}`;
      this.completeDurableReset(path, archivePath);
      this.pruneArchives(chatId, "reset");
    });
  }

  private filePath(chatId: string): string {
    return join(this.sessionsDir, `${chatId}.jsonl`);
  }

  hasSession(chatId: string): boolean {
    return existsSync(this.filePath(chatId));
  }

  load(chatId: string): { messages: ModelMessage[]; lastMessageTime: string | null } {
    const path = this.filePath(chatId);
    if (!existsSync(path)) return { messages: [], lastMessageTime: null };

    const lines = readFileSync(path, "utf-8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const good: string[] = [];
    const corrupt: string[] = [];
    const parsed: JsonlLine[] = [];
    for (const line of lines) {
      const entry = parseSessionLine(line);
      if (entry === null) {
        corrupt.push(line);
      } else {
        good.push(line);
        parsed.push(entry);
      }
    }

    if (corrupt.length > 0) {
      try {
        this.quarantineCorruptLines(chatId, good, corrupt);
      } catch (err) {
        console.warn(
          "Failed to quarantine corrupt session lines; continuing with parseable lines",
          err,
        );
      }
    }

    const messages = parsed.map((p) =>
      setMessageProvenance(
        { role: p.role, content: p.content } as ModelMessage,
        p.role === "user" ? UNKNOWN_PROVENANCE : (p.provenance ?? UNKNOWN_PROVENANCE),
      ),
    );

    let lastMessageTime: string | null = null;
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (parsed[i].role !== "system") {
        lastMessageTime = parsed[i].ts;
        break;
      }
    }

    return { messages, lastMessageTime };
  }

  appendMessage(
    chatId: string,
    role: "user" | "assistant",
    content: string,
    lineage?: ChatLineage & { provenance?: SourceProvenance },
  ): void {
    // An empty assistant reply pollutes the next turn's loaded history. Skip it
    // and warn — never throw, so a deliver-first turn can't crash on a guarded
    // append.
    if (role === "assistant" && content.trim() === "") {
      console.warn("Skipping empty assistant message append");
      return;
    }
    const path = this.filePath(chatId);
    const line: JsonlLine =
      lineage === undefined
        ? { role, content, ts: new Date().toISOString() }
        : { role, content, ts: new Date().toISOString(), ...lineage };
    appendFileSync(path, JSON.stringify(line) + "\n", { encoding: "utf-8", mode: 0o600 });
  }

  appendTurn(
    chatId: string,
    userContent: string,
    assistantContent: string,
    lineage: ChatLineage & { provenance?: SourceProvenance },
  ): void {
    // Keep the atomic pair honest: an empty assistant reply must never persist,
    // and a lone user line with no reply is the same context pollution. Skip the
    // whole turn and warn — never throw (deliver-first).
    if (assistantContent.trim() === "") {
      console.warn("Skipping turn with empty assistant content");
      return;
    }
    const path = this.filePath(chatId);
    const ts = new Date().toISOString();
    const userLine: JsonlLine = { role: "user", content: userContent, ts };
    const assistantLine: JsonlLine = {
      role: "assistant",
      content: assistantContent,
      ts,
      ...lineage,
    };
    // Both lines in one buffer and one write so the pair lands together or not
    // at all — a partial write can never leave a dangling user line.
    const buffer = JSON.stringify(userLine) + "\n" + JSON.stringify(assistantLine) + "\n";
    appendFileSync(path, buffer, { encoding: "utf-8", mode: 0o600 });
  }

  overwriteHistory(chatId: string, messages: ModelMessage[]): void {
    const path = this.filePath(chatId);
    const tmpPath = `${path}.tmp`;
    const now = new Date().toISOString();

    // Preserve the original timestamp of a message that survives the rewrite so
    // freshness/idle math keeps working across a compaction. Timestamps are read
    // back from the existing file by (role, content); a summary/system line is a
    // freshly-generated artifact and always gets `now`. Build a per-key queue so
    // duplicate lines keep the stamp whose source label matches the surviving
    // message, falling back to occurrence order when the labels are identical.
    const preservedByKey = new Map<string, Array<{ ts: string; provenance?: SourceProvenance }>>();
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf-8").split("\n")) {
        if (line.trim() === "") continue;
        const entry = parseSessionLine(line);
        if (entry === null || entry.role === "system") continue;
        const key = `${entry.role}\n${entry.content}`;
        const queue = preservedByKey.get(key);
        const preserved = { ts: entry.ts, provenance: entry.provenance };
        if (queue) queue.push(preserved);
        else preservedByKey.set(key, [preserved]);
      }
    }

    const content =
      messages
        .map((m) => {
          const role = m.role as JsonlLine["role"];
          const text = messageText(m);
          let ts = now;
          const provenance = getMessageProvenance(m);
          if (role !== "system") {
            const queue = preservedByKey.get(`${role}\n${text}`);
            const matchingIndex = queue?.findIndex((candidate) =>
              sameProvenance(candidate.provenance ?? UNKNOWN_PROVENANCE, provenance),
            );
            const preserved =
              queue !== undefined && matchingIndex !== undefined && matchingIndex >= 0
                ? queue.splice(matchingIndex, 1)[0]
                : queue?.shift();
            if (preserved !== undefined) {
              ts = preserved.ts;
            }
          }
          const line: JsonlLine = {
            role,
            content: text,
            ts,
            ...(role === "user" ? {} : { provenance }),
          };
          return JSON.stringify(line);
        })
        .join("\n") + "\n";
    writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, path);
  }

  // Terminal failure marker: makes a turn that died before producing a reply
  // visible in history instead of leaving a bare user line with no answer. The
  // athlete's message stays durable (it was appended before generation); this
  // records that the turn did not complete. No-op when no session file exists.
  appendFailureMarker(chatId: string): void {
    const path = this.filePath(chatId);
    if (!existsSync(path)) return;
    const line: JsonlLine = {
      role: "system",
      content: TURN_FAILURE_MARKER,
      ts: new Date().toISOString(),
    };
    appendFileSync(path, JSON.stringify(line) + "\n", { encoding: "utf-8", mode: 0o600 });
  }

  archiveAndReset(chatId: string): void {
    const path = this.filePath(chatId);
    const ts = new Date().toISOString().replace(/:/g, "-");
    const archivePath = `${path}.reset.${ts}`;
    const sessionExists = existsSync(path);
    const archiveExists = existsSync(archivePath);
    if (sessionExists && archiveExists) {
      throw new Error("Reset archive and active session both exist.");
    }
    if (!sessionExists) return;

    renameSync(path, archivePath);
    this.syncSessionsDirectory();
    this.pruneArchives(chatId, "reset");
  }

  archivePreCompact(chatId: string): void {
    const path = this.filePath(chatId);
    if (!existsSync(path)) return;

    const ts = new Date().toISOString().replace(/:/g, "-");
    copyFileSync(path, `${path}.precompact.${ts}`);
    this.pruneArchives(chatId, "precompact");
  }

  private quarantineCorruptLines(chatId: string, good: string[], corrupt: string[]): void {
    const path = this.filePath(chatId);
    const ts = new Date().toISOString().replace(/:/g, "-");
    const sidecarPath = `${path}.corrupt.${ts}`;
    appendFileSync(sidecarPath, corrupt.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
    if (good.length === 0) {
      unlinkSync(path);
      console.warn(
        `Quarantined ${corrupt.length} corrupt session line(s) to ${sidecarPath}; removed empty session`,
      );
      return;
    }
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, good.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, path);
    console.warn(
      `Quarantined ${corrupt.length} corrupt session line(s) to ${sidecarPath}; kept ${good.length} valid line(s)`,
    );
  }

  private pruneArchives(chatId: string, suffix: "reset" | "precompact"): void {
    if (this.resetArchiveRetentionDays <= 0) return;
    const prefix = `${chatId}.jsonl.${suffix}.`;
    const cutoffMs = Date.now() - this.resetArchiveRetentionDays * MS_PER_DAY;
    for (const name of readdirSync(this.sessionsDir)) {
      if (!name.startsWith(prefix)) continue;
      const archivedAtMs = parseArchiveTimestampMs(name.slice(prefix.length));
      // Unparseable timestamps are kept: never delete an archive that
      // cannot be dated.
      if (archivedAtMs !== null && archivedAtMs < cutoffMs) {
        unlinkSync(join(this.sessionsDir, name));
      }
    }
  }

  private syncSessionsDirectory(): void {
    this.withSessionsDirectory((descriptor) => {
      this.syncDirectory(descriptor);
      this.assertSessionsDirectoryStable(descriptor);
    });
  }

  private completeDurableReset(path: string, archivePath: string): void {
    this.withSessionsDirectory((directoryDescriptor) => {
      const readStats = (candidate: string) => {
        try {
          return lstatSync(candidate);
        } catch (error) {
          if (isMissing(error)) return null;
          throw error;
        }
      };
      const active = readStats(path);
      const archive = readStats(archivePath);
      if (active === null) {
        if (archive !== null) {
          if (!isStrictPrivateFile(archive, 1)) {
            throw new Error("Reset archive target is unsafe.");
          }
          this.assertSessionsDirectoryStable(directoryDescriptor);
          this.syncDirectory(directoryDescriptor);
          this.assertSessionsDirectoryStable(directoryDescriptor);
        }
        return;
      }
      if (archive !== null) {
        this.assertLinkedResetTargets(active, archive);
        this.syncStableSessionFile(directoryDescriptor, path, identity(active), 2);
        this.assertLinkedResetPaths(directoryDescriptor, path, archivePath, identity(active));
      } else {
        if (!isStrictPrivateFile(active, 1)) {
          throw new Error("Active reset session target is unsafe.");
        }
        this.syncStableSessionFile(directoryDescriptor, path, identity(active), 1);
        linkSync(path, archivePath);
        this.assertLinkedResetPaths(directoryDescriptor, path, archivePath, identity(active));
        this.syncDirectory(directoryDescriptor);
        this.assertLinkedResetPaths(directoryDescriptor, path, archivePath, identity(active));
      }

      this.assertLinkedResetPaths(directoryDescriptor, path, archivePath, identity(active));
      unlinkSync(path);
      this.assertSessionsDirectoryStable(directoryDescriptor);
      this.syncDirectory(directoryDescriptor);
      this.assertSessionsDirectoryStable(directoryDescriptor);
      const completed = lstatSync(archivePath);
      if (
        !isStrictPrivateFile(completed, 1) ||
        !sameIdentity(identity(completed), identity(active))
      ) {
        throw new Error("Reset archive did not complete safely.");
      }
    });
  }

  private syncStableSessionFile(
    directoryDescriptor: number,
    path: string,
    expectedIdentity: FileIdentity,
    expectedLinks: 1 | 2,
  ): void {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor);
      const current = lstatSync(path);
      if (
        !isStrictPrivateFile(opened, expectedLinks) ||
        !isStrictPrivateFile(current, expectedLinks) ||
        !sameIdentity(identity(opened), expectedIdentity) ||
        !sameIdentity(identity(current), expectedIdentity)
      ) {
        throw new Error("Active reset session was raced.");
      }
      this.assertSessionsDirectoryStable(directoryDescriptor);
      (CHAT_STORE_HOOKS.get(this)?.syncFile ?? fsyncSync)(descriptor);
      const synced = fstatSync(descriptor);
      const afterSync = lstatSync(path);
      if (
        !isStrictPrivateFile(synced, expectedLinks) ||
        !isStrictPrivateFile(afterSync, expectedLinks) ||
        !sameIdentity(identity(synced), expectedIdentity) ||
        !sameIdentity(identity(afterSync), expectedIdentity)
      ) {
        throw new Error("Active reset session was raced.");
      }
      this.assertSessionsDirectoryStable(directoryDescriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private assertLinkedResetTargets(
    active: import("node:fs").Stats,
    archive: import("node:fs").Stats,
  ): void {
    if (
      !isStrictPrivateFile(active, 2) ||
      !isStrictPrivateFile(archive, 2) ||
      !sameIdentity(identity(active), identity(archive))
    ) {
      throw new Error("Reset archive and active session do not agree.");
    }
  }

  private assertLinkedResetPaths(
    directoryDescriptor: number,
    path: string,
    archivePath: string,
    expectedIdentity: FileIdentity,
  ): void {
    const active = lstatSync(path);
    const archive = lstatSync(archivePath);
    this.assertLinkedResetTargets(active, archive);
    if (!sameIdentity(identity(active), expectedIdentity)) {
      throw new Error("Reset archive publication was raced.");
    }
    this.assertSessionsDirectoryStable(directoryDescriptor);
  }

  private withSessionsDirectory<T>(operation: (descriptor: number) => T): T {
    const beforeOpen = lstatSync(this.sessionsDir);
    if (
      !isStrictPrivateDirectory(beforeOpen) ||
      !sameIdentity(identity(beforeOpen), this.sessionsDirectoryIdentity)
    ) {
      throw new Error("Sessions directory is unsafe.");
    }
    const descriptor = openSync(
      this.sessionsDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      this.assertSessionsDirectoryStable(descriptor);
      return operation(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private assertSessionsDirectoryStable(descriptor: number): void {
    const current = lstatSync(this.sessionsDir);
    const opened = fstatSync(descriptor);
    if (
      !isStrictPrivateDirectory(current) ||
      !isStrictPrivateDirectory(opened) ||
      !sameIdentity(identity(current), this.sessionsDirectoryIdentity) ||
      !sameIdentity(identity(opened), this.sessionsDirectoryIdentity)
    ) {
      throw new Error("Sessions directory is unsafe.");
    }
  }

  private syncDirectory(descriptor: number): void {
    (CHAT_STORE_HOOKS.get(this)?.syncDirectory ?? fsyncSync)(descriptor);
  }
}

export function createChatStoreWithHooks(
  dataDir: string,
  resetArchiveRetentionDays: number,
  hooks: ChatStoreHooks,
): ChatStore {
  const store = new ChatStore(dataDir, resetArchiveRetentionDays);
  CHAT_STORE_HOOKS.set(store, hooks);
  return store;
}

export function archiveAndResetDurably(
  store: ChatStore,
  chatId: string,
  reset: DurableChatReset,
): void {
  if (
    !/^[a-f0-9]{64}$/.test(reset.resetId) ||
    new Date(reset.boundaryAt).toISOString() !== reset.boundaryAt
  ) {
    throw new TypeError("Durable chat reset metadata is invalid.");
  }
  const operation = DURABLE_RESET_OPERATIONS.get(store);
  if (operation === undefined) throw new TypeError("Durable chat reset store is invalid.");
  operation(chatId, reset);
}
