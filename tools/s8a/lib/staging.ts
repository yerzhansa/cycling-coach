import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { S8aScenario } from "./types.js";

export function stageHome(tempHome: string, scenario: S8aScenario): void {
  mkdirSync(join(tempHome, "memory"), { recursive: true });
  mkdirSync(join(tempHome, "sessions"), { recursive: true });
  const home = scenario.home;
  if (home === undefined) return;
  if (home.memoryMd !== undefined) {
    writeFileSync(join(tempHome, "memory", "MEMORY.md"), home.memoryMd, "utf-8");
  }
  if (home.eventsJsonl !== undefined) {
    writeFileSync(join(tempHome, "memory", "events.jsonl"), home.eventsJsonl, "utf-8");
  }
  for (const [chatId, content] of Object.entries(home.sessions ?? {})) {
    writeFileSync(join(tempHome, "sessions", `${chatId}.jsonl`), content, "utf-8");
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
