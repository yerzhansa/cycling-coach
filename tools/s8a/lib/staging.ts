import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { S8aScenario } from "./types.js";

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function stageHome(tempHome: string, scenario: S8aScenario): void {
  ensurePrivateDirectory(tempHome);
  ensurePrivateDirectory(join(tempHome, "memory"));
  ensurePrivateDirectory(join(tempHome, "sessions"));
  const home = scenario.home;
  if (home === undefined) return;
  if (home.memoryMd !== undefined) {
    writePrivateFile(join(tempHome, "memory", "MEMORY.md"), home.memoryMd);
  }
  if (home.eventsJsonl !== undefined) {
    writePrivateFile(join(tempHome, "memory", "events.jsonl"), home.eventsJsonl);
  }
  for (const [chatId, content] of Object.entries(home.sessions ?? {})) {
    writePrivateFile(join(tempHome, "sessions", `${chatId}.jsonl`), content);
  }
}

// The asserted artifact set. logs/ is excluded (it carries the random turnId),
// so the determinism probe's byte-compare is closed over deterministic bytes.
export const ASSERTED_MEMORY_FILES = ["MEMORY.md", "events.jsonl", "MEMORY.history.jsonl"] as const;

export function snapshotHome(tempHome: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const name of ASSERTED_MEMORY_FILES) {
    const src = join(tempHome, "memory", name);
    if (existsSync(src)) {
      mkdirSync(join(destDir, "memory"), { recursive: true });
      cpSync(src, join(destDir, "memory", name));
    }
  }
  const ledger = join(tempHome, "usage-ledger.jsonl");
  if (existsSync(ledger)) cpSync(ledger, join(destDir, "usage-ledger.jsonl"));
  const sessionsDir = join(tempHome, "sessions");
  if (existsSync(sessionsDir) && readdirSync(sessionsDir).length > 0) {
    cpSync(sessionsDir, join(destDir, "sessions"), { recursive: true });
  }
}
