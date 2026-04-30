import type { MemorySectionSpec, Sport } from "../sport.js";
import { CORE_SHARED_SECTIONS } from "./shared-sections.js";

// Module-level cache: memoizes warn-once per (sport.id, section.name, kind)
// across the process lifetime. Without this, every createTools / memory_flush
// call would re-fire the same warnings. Process-scoped is correct — the
// warning is about a code/config bug that won't change without a restart.
const WARNED = new Set<string>();

const CORE_NAMES: ReadonlySet<string> = new Set(CORE_SHARED_SECTIONS.map((s) => s.name));

function warnOnce(key: string, message: string): void {
  if (WARNED.has(key)) return;
  WARNED.add(key);
  console.warn(message);
}

/**
 * Composes Core's shared sections with a sport's declared sections,
 * deduplicated by name with Core-wins on collision (per ADR-0003).
 * Two distinct misuse warnings:
 * - "core-collision": sport declares a Core-shared name → Core's spec wins
 * - "self-dup": sport's array contains the same name twice → first wins
 * Both fire once per (sport.id, name) pair via the module-level cache.
 */
export function getEffectiveSections(sport: Sport): readonly MemorySectionSpec[] {
  const seen = new Map<string, MemorySectionSpec>();
  for (const spec of CORE_SHARED_SECTIONS) {
    seen.set(spec.name, spec);
  }
  const sportNamesSeen = new Set<string>();
  for (const spec of sport.memorySections) {
    if (sportNamesSeen.has(spec.name)) {
      warnOnce(
        `${sport.id}:${spec.name}:self-dup`,
        `Sport "${sport.id}" declares section "${spec.name}" more than once in ` +
          `memorySections; using the first occurrence.`,
      );
      continue;
    }
    sportNamesSeen.add(spec.name);
    if (CORE_NAMES.has(spec.name)) {
      warnOnce(
        `${sport.id}:${spec.name}:core-collision`,
        `Sport "${sport.id}" declares section "${spec.name}" which is Core-shared; ` +
          `using Core's spec. Remove from sport.memorySections to silence this warning.`,
      );
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
