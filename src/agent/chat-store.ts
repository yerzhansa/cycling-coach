import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";

interface JsonlLine {
  role: "user" | "assistant";
  content: string;
  ts: string;
}

export class ChatStore {
  private sessionsDir: string;

  constructor(dataDir: string) {
    this.sessionsDir = join(dataDir, "sessions");
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  private filePath(chatId: string): string {
    return join(this.sessionsDir, `${chatId}.jsonl`);
  }

  getHistory(chatId: string): ModelMessage[] {
    return this.load(chatId).messages;
  }

  load(chatId: string): { messages: ModelMessage[]; lastMessageTime: string | null } {
    const path = this.filePath(chatId);
    if (!existsSync(path)) return { messages: [], lastMessageTime: null };

    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return { messages: [], lastMessageTime: null };

    const lines = raw.split("\n");
    const messages = lines.map((line) => {
      const parsed: JsonlLine = JSON.parse(line);
      return { role: parsed.role, content: parsed.content } as ModelMessage;
    });

    const lastParsed: JsonlLine = JSON.parse(lines[lines.length - 1]);
    return { messages, lastMessageTime: lastParsed.ts };
  }

  appendMessage(chatId: string, role: "user" | "assistant", content: string): void {
    const path = this.filePath(chatId);
    const line: JsonlLine = { role, content, ts: new Date().toISOString() };
    appendFileSync(path, JSON.stringify(line) + "\n", "utf-8");
  }

  getLastMessageTime(chatId: string): string | null {
    const path = this.filePath(chatId);
    if (!existsSync(path)) return null;

    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;

    const lines = raw.split("\n");
    const last: JsonlLine = JSON.parse(lines[lines.length - 1]);
    return last.ts;
  }

  overwriteHistory(chatId: string, messages: ModelMessage[]): void {
    const path = this.filePath(chatId);
    const lines = messages.map((m) => {
      const line: JsonlLine = {
        role: m.role as "user" | "assistant",
        content: typeof m.content === "string" ? m.content : "",
        ts: new Date().toISOString(),
      };
      return JSON.stringify(line);
    });
    writeFileSync(path, lines.join("\n") + "\n", "utf-8");
  }

  archiveAndReset(chatId: string): void {
    const path = this.filePath(chatId);
    if (!existsSync(path)) return;

    const ts = new Date().toISOString().replace(/:/g, "-");
    const archivePath = `${path}.reset.${ts}`;
    renameSync(path, archivePath);
  }
}
