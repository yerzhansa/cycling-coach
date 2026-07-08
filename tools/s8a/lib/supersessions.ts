import { readFileSync } from "node:fs";

import type { PendingHashMismatch } from "./types.js";

export interface SupersessionEntry {
  id: string;
  date: string;
  prRef: string;
  lineageVersion: string;
  fromTemplateHash: string;
  toTemplateHash: string;
  scope: string[];
  callers?: string[];
  reason: string;
  approvedBy: string;
}

export function parseSupersessions(content: string): SupersessionEntry[] {
  const entries: SupersessionEntry[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    const value = JSON.parse(line) as SupersessionEntry;
    if (
      typeof value.id !== "string" ||
      typeof value.fromTemplateHash !== "string" ||
      typeof value.toTemplateHash !== "string" ||
      !Array.isArray(value.scope)
    ) {
      throw new Error(`malformed supersession entry: ${line}`);
    }
    entries.push(value);
  }
  return entries;
}

export function loadSupersessions(path: string): SupersessionEntry[] {
  return parseSupersessions(readFileSync(path, "utf-8"));
}

export function findSupersession(
  entries: SupersessionEntry[],
  fromTemplateHash: string,
  toTemplateHash: string,
): SupersessionEntry | undefined {
  return entries.find(
    (e) =>
      e.scope.includes("system-prompt") &&
      e.fromTemplateHash === fromTemplateHash &&
      e.toTemplateHash === toTemplateHash,
  );
}

export interface PendingResolution {
  kind: "warn" | "fail";
  entry?: SupersessionEntry;
  detail: string;
}

/** Resolves a PENDING A1/A3 hash mismatch after the turn: joins the recorded
 *  templateHash against the turn's live session assistant-line templateHash and
 *  consults the registry. A null registry is the `--no-supersessions` self-test
 *  mode: the mismatch always rules FAIL, even on an exact hash pair. */
export function resolvePending(
  pending: PendingHashMismatch,
  liveTemplateHash: string | null,
  registry: SupersessionEntry[] | null,
): PendingResolution {
  if (liveTemplateHash === null) {
    return {
      kind: "fail",
      detail: `${pending.detail} (turn wrote no session assistant line — no supersession path)`,
    };
  }
  if (registry === null || pending.recordedTemplateHash === undefined) {
    return { kind: "fail", detail: pending.detail };
  }
  const entry = findSupersession(registry, pending.recordedTemplateHash, liveTemplateHash);
  if (entry === undefined) {
    return { kind: "fail", detail: pending.detail };
  }
  return {
    kind: "warn",
    entry,
    detail: `${pending.detail} — documented supersession ${entry.id}`,
  };
}

/** Field-level excuse on an A5-compared JSONL line. `system-prompt` scope
 *  excuses the templateHash field iff baseline==from AND live==to, and the
 *  assembledHash field on exactly the lines whose templateHash matched the
 *  pair. `ledger:model` scope (requires callers) excuses only model/cost for
 *  the named callers. NO scope can ever excuse an A2 or A4 failure. */
export function isFieldExcused(params: {
  entries: SupersessionEntry[];
  field: string;
  baselineLine: Record<string, unknown>;
  liveLine: Record<string, unknown>;
}): boolean {
  const { entries, field, baselineLine, liveLine } = params;
  for (const entry of entries) {
    if (entry.scope.includes("system-prompt")) {
      const pairMatches =
        baselineLine.templateHash === entry.fromTemplateHash &&
        liveLine.templateHash === entry.toTemplateHash;
      if (field === "templateHash" && pairMatches) return true;
      if (field === "assembledHash" && pairMatches) return true;
    }
    if (entry.scope.includes("ledger:model")) {
      const callers = entry.callers ?? [];
      const caller = liveLine.caller;
      if (
        (field === "model" || field === "cost") &&
        typeof caller === "string" &&
        callers.includes(caller)
      ) {
        return true;
      }
    }
  }
  return false;
}
