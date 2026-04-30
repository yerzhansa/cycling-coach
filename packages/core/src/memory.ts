/**
 * Sport-agnostic memory abstractions consumed by Core and Sports.
 *
 * `MemoryStore` is the writable surface tools and the agent loop use.
 * `MemorySnapshot` is a read-only sectioned view passed to a Sport's
 * `mustPreserveTokens` function so it can derive data-bound tokens
 * (e.g. "FTP 247W") from current memory state.
 */

export interface MemoryStore {
  /** Returns full MEMORY.md contents, or "" if absent. */
  readMemory(): string;

  /** Replaces the named section's content; appends if section is missing. */
  writeSection(section: string, content: string): void;

  /**
   * Renames `from` section to `to`. Lossless:
   * - "renamed": `from` existed, `to` did not — header rewritten in place.
   * - "noop":    file missing or `from` not present.
   * - "merged":  both `from` and `to` exist — bodies concatenated under `to`,
   *              `from` block removed.
   */
  renameSection(from: string, to: string): "renamed" | "noop" | "merged";

  /** Reads today's daily-notes file (or for `date` when supplied). */
  readDailyNotes(date?: string): string;

  /** Appends a note to today's daily-notes file. */
  appendDailyNote(note: string, date?: string): void;

  /** Persists the active training plan as JSON. */
  savePlan(plan: unknown): void;

  /** Loads the active training plan, or null if none. */
  loadPlan(): unknown | null;

  /** Sync point invoked after compaction or memory flush. */
  reload(): void;

  /** Composed string Core feeds into the system prompt's Athlete Context. */
  getContext(): string;
}

export interface MemorySnapshot {
  /** Returns section content, or null if section is empty/absent. */
  read(sectionName: string): string | null;

  /** True if the section exists and has non-empty content. */
  has(sectionName: string): boolean;

  /** All section names visible in this snapshot. */
  listSections(): readonly string[];
}
