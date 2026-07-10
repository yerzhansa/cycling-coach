import type { MemoryStore } from "../memory.js";
import type { MemorySectionSpec } from "../sport.js";
import { truncateUtf16Safe } from "../text-truncate.js";
import { createMemorySnapshot } from "./snapshot.js";

const WARNED = new Set<string>();
const MAX_LOGGED_NAME_CHARS = 40;

/**
 * Warns (once per process per name) about MEMORY.md sections that are not in
 * the effective section set — they are injected every turn but never listed
 * in the flush prompt, so nothing curates them. Names only, truncated: a
 * phantom "section" can be athlete-authored text via an embedded `## ` line,
 * so bodies and long names must not land in logs.
 */
export function warnOrphanSections(
  memory: MemoryStore,
  effectiveSections: readonly MemorySectionSpec[],
): void {
  const effective = new Set(effectiveSections.map((s) => s.name));
  const orphans = createMemorySnapshot(memory)
    .listSections()
    .filter((name) => !effective.has(name) && !WARNED.has(name));
  if (orphans.length === 0) return;
  for (const name of orphans) WARNED.add(name);
  console.warn(
    JSON.stringify({
      event: "memory_orphan_sections",
      names: orphans.map((n) => truncateUtf16Safe(n, MAX_LOGGED_NAME_CHARS)),
      hint: "These sections are injected every turn but never flushed/curated; rename into a declared section or delete.",
    }),
  );
}

/** Test-only escape hatch — reset the warn cache between unit tests. */
export function _resetOrphanWarnCacheForTesting(): void {
  WARNED.clear();
}
