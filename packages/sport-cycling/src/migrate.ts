import type { MemoryStore } from "@enduragent/core";

const LEGACY_RENAMES = [
  ["profile", "cycling-profile"],
  ["equipment", "cycling-equipment"],
  ["health", "cycling-history"],
] as const;

/**
 * Apply all three legacy renames as a single in-memory transform + single
 * atomic write to MEMORY.md. Replaces the prior per-rename loop so that
 * either the migration lands in full or not at all — the Reference layer's
 * init order assumes the next step never sees a half-migrated MEMORY.md
 * (ADR-0011 commit-marker pattern applied to memory writes).
 */
export function migrateCyclingLegacySections(memory: MemoryStore): void {
  let outcomes: Array<"renamed" | "noop" | "merged">;
  try {
    outcomes = memory.renameSections(LEGACY_RENAMES, "migration");
  } catch (err) {
    console.warn(
      JSON.stringify({
        event: "section_rename_bulk_failed",
        error: String(err),
      }),
    );
    return;
  }

  for (let i = 0; i < LEGACY_RENAMES.length; i++) {
    const [from, to] = LEGACY_RENAMES[i];
    console.log(
      JSON.stringify({ event: "section_rename", from, to, outcome: outcomes[i] }),
    );
  }
}
