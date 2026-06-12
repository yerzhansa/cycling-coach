/**
 * Append-only journal of destructive memory writes.
 *
 * One JSON line per write, appended BEFORE the mutation (a crash between
 * journal and write leaves a harmless extra line, never an unjournaled
 * destruction). Best-effort: a journal failure warns and never throws, so
 * a full disk or permission error cannot break the memory write itself.
 * Mode 0600 — entries carry athlete medical data.
 */
import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { MemoryWriteSource } from "../memory.js";

export const JOURNAL_FILENAME = "MEMORY.history.jsonl";

export type MemoryJournalOp = "write-section" | "save-plan" | "rename-sections";

export interface MemoryJournalEntry {
  ts: string;
  op: MemoryJournalOp;
  section: string | null;
  oldBody: string | null;
  newBody: string;
  source: MemoryWriteSource;
}

export function appendJournalEntry(memoryDir: string, entry: MemoryJournalEntry): void {
  let fd: number | null = null;
  try {
    fd = openSync(join(memoryDir, JOURNAL_FILENAME), "a", 0o600);
    writeSync(fd, JSON.stringify(entry) + "\n", null, "utf-8");
  } catch (err) {
    console.warn(
      `memory journal append failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore — best-effort journal; the memory write itself must proceed.
      }
    }
  }
}
