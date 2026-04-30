import type { MemorySectionSpec, Sport } from "../sport.js";
import { CORE_SHARED_SECTIONS } from "./shared-sections.js";

// Module-level cache: memoizes warn-once per (sport.id, section.name) pair
// across the process lifetime. Without this, every createTools / memory_flush
// call would re-fire the same transitional warnings. Process-scoped is correct
// — the warning is about a code/config bug that won't change without a restart.
const WARNED = new Set<string>();

/**
 * Composes Core's shared sections with a sport's declared sections,
 * deduplicated by name with Core-wins on collision (per ADR-0003).
 * A sport that mistakenly declares a Core-shared name silently gets
 * Core's spec rather than crashing in production; a console.warn fires
 * once per (sport.id, name) pair.
 */
export function getEffectiveSections(sport: Sport): readonly MemorySectionSpec[] {
  const seen = new Map<string, MemorySectionSpec>();
  for (const spec of CORE_SHARED_SECTIONS) {
    seen.set(spec.name, spec);
  }
  for (const spec of sport.memorySections) {
    if (seen.has(spec.name)) {
      const key = `${sport.id}:${spec.name}`;
      if (!WARNED.has(key)) {
        WARNED.add(key);
        console.warn(
          `Sport "${sport.id}" declares section "${spec.name}" which is Core-shared; ` +
            `using Core's spec. Remove from sport.memorySections to silence this warning.`,
        );
      }
      continue;
    }
    seen.set(spec.name, spec);
  }
  return Array.from(seen.values());
}

/** Test-only escape hatch — reset the warn cache between unit tests. */
export function _resetWarnCacheForTesting(): void {
  WARNED.clear();
}
