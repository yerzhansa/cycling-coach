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

const MAX_RESET_ARCHIVES = 20;

interface JsonlLine {
  role: "user" | "assistant" | "system";
  content: string;
  ts: string;
}

export class ChatStore {
  private sessionsDir: string;

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, "sessions");
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
    const prefix = `${chatId}.jsonl.reset.`;
    // Archive names embed a fixed-width ISO timestamp, so a lexicographic
    // sort is chronological — the oldest archives sort first.
    const archives = readdirSync(this.sessionsDir)
      .filter((f) => f.startsWith(prefix))
      .sort();
    for (const stale of archives.slice(0, Math.max(0, archives.length - MAX_RESET_ARCHIVES))) {
      unlinkSync(join(this.sessionsDir, stale));
    }
  }
}
