import type { MemoryStore } from "@cycling-coach/core";

const LEGACY_RENAMES = [
  ["profile", "cycling-profile"],
  ["equipment", "cycling-equipment"],
  ["health", "cycling-history"],
] as const;

export function migrateCyclingLegacySections(memory: MemoryStore): void {
  for (const [from, to] of LEGACY_RENAMES) {
    try {
      const outcome = memory.renameSection(from, to);
      console.log(JSON.stringify({ event: "section_rename", from, to, outcome }));
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "section_rename_failed",
          from,
          to,
          error: String(err),
        }),
      );
    }
  }
}
