import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * On-disk Telegram session metadata, used by both the access-control surface
 * (notifyUpdate broadcast filter, list-senders CLI) and the updater
 * (getKnownTelegramChatIds). One walker so the filename convention
 * (`telegram:<chatId>.jsonl`) lives in a single place.
 */
export interface TelegramSessionFile {
  chatId: string;
  path: string;
  mtimeMs: number;
}

const PREFIX = "telegram:";
const SUFFIX = ".jsonl";

export function enumerateTelegramSessions(dataDir: string): TelegramSessionFile[] {
  const sessionsDir = join(dataDir, "sessions");
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const out: TelegramSessionFile[] = [];
  for (const name of entries) {
    if (!name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) continue;
    const chatId = name.slice(PREFIX.length, -SUFFIX.length);
    const path = join(sessionsDir, name);
    try {
      out.push({ chatId, path, mtimeMs: statSync(path).mtimeMs });
    } catch {
      // File disappeared between readdir and stat — skip.
    }
  }
  return out;
}
