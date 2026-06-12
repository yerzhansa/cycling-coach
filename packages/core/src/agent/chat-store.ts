import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { messageText } from "./token-utils.js";

const MS_PER_DAY = 86_400_000;

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

    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return { messages: [], lastMessageTime: null };

    const parsed = raw.split("\n").map((line) => JSON.parse(line) as JsonlLine);
    const messages = parsed.map(
      (p) => ({ role: p.role, content: p.content }) as ModelMessage,
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

  appendMessage(chatId: string, role: "user" | "assistant", content: string): void {
    const path = this.filePath(chatId);
    const line: JsonlLine = { role, content, ts: new Date().toISOString() };
    appendFileSync(path, JSON.stringify(line) + "\n", { encoding: "utf-8", mode: 0o600 });
  }

  overwriteHistory(chatId: string, messages: ModelMessage[]): void {
    const path = this.filePath(chatId);
    const tmpPath = `${path}.tmp`;
    const now = new Date().toISOString();
    const content = messages
      .map((m) => {
        const line: JsonlLine = {
          role: m.role as JsonlLine["role"],
          content: messageText(m),
          ts: now,
        };
        return JSON.stringify(line);
      })
      .join("\n") + "\n";
    writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, path);
  }

  archiveAndReset(chatId: string): void {
    const path = this.filePath(chatId);
    if (!existsSync(path)) return;

    const ts = new Date().toISOString().replace(/:/g, "-");
    const archivePath = `${path}.reset.${ts}`;
    renameSync(path, archivePath);
    this.pruneArchives(chatId);
  }

  private pruneArchives(chatId: string): void {
    if (this.resetArchiveRetentionDays <= 0) return;
    const prefix = `${chatId}.jsonl.reset.`;
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
