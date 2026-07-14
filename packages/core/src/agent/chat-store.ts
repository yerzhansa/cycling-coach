import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { messageText } from "./token-utils.js";
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

function parseArchiveTimestampMs(suffix: string): number | null {
  // archiveAndReset writes toISOString() with ":" replaced by "-"; reverse
  // only the time-part dashes before parsing.
  const ms = Date.parse(suffix.replace(/T(\d{2})-(\d{2})-(\d{2})/, "T$1:$2:$3"));
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
  for (const k of ["templateHash", "assembledHash", "provider", "model"] as const) {
    if (k in v && typeof v[k] !== "string") return null;
  }
  if ("provenance" in v && !isSourceProvenance(v.provenance)) {
    return { ...v, provenance: undefined } as JsonlLine;
  }
  return value as JsonlLine;
}

export class ChatStore {
  private sessionsDir: string;
  private resetArchiveRetentionDays: number;

  constructor(dataDir: string, resetArchiveRetentionDays = 0) {
    this.sessionsDir = join(dataDir, "sessions");
    this.resetArchiveRetentionDays = resetArchiveRetentionDays;
    mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
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
    lineage?: {
      templateHash: string;
      assembledHash: string;
      provider: string;
      model: string;
      provenance?: SourceProvenance;
    },
  ): void {
    // An empty assistant reply pollutes the next turn's loaded history. Skip it
    // and warn — never throw, so a deliver-first turn can't crash on a guarded
    // append.
    if (role === "assistant" && content.trim() === "") {
      console.warn("Skipping empty assistant message append");
      return;
    }
    const path = this.filePath(chatId);
    const line: JsonlLine = { role, content, ts: new Date().toISOString(), ...lineage };
    appendFileSync(path, JSON.stringify(line) + "\n", { encoding: "utf-8", mode: 0o600 });
  }

  appendTurn(
    chatId: string,
    userContent: string,
    assistantContent: string,
    lineage: {
      templateHash: string;
      assembledHash: string;
      provider: string;
      model: string;
      provenance?: SourceProvenance;
    },
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
    // duplicate lines each keep their own original stamp in order.
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
          let provenance = getMessageProvenance(m);
          if (role !== "system") {
            const queue = preservedByKey.get(`${role}\n${text}`);
            const preserved = queue?.shift();
            if (preserved !== undefined) {
              ts = preserved.ts;
              provenance = preserved.provenance ?? provenance;
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
    if (!existsSync(path)) return;

    const ts = new Date().toISOString().replace(/:/g, "-");
    const archivePath = `${path}.reset.${ts}`;
    renameSync(path, archivePath);
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
}
