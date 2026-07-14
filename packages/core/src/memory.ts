/**
 * Sport-agnostic memory abstractions consumed by Core and Sports.
 *
 * `MemoryStore` is the writable surface tools and the agent loop use.
 * `MemorySnapshot` is a read-only sectioned view passed to a Sport's
 * `mustPreserveTokens` function so it can derive data-bound tokens
 * (e.g. "FTP 247W") from current memory state.
 */

import type { LedgerEventInput } from "./memory/event-ledger.js";
import type { SourceProvenance } from "./provenance.js";

/** Who performed a destructive memory write — recorded on every journal line. */
export type MemoryWriteSource = "chat-tool" | "flush" | "sport-tool" | "migration" | "unattributed";

export interface MemoryStore {
  /** Returns full MEMORY.md contents, or "" if absent. */
  readMemory(): string;

  /** Replaces the named section's content; appends if section is missing. */
  writeSection(
    section: string,
    content: string,
    source?: MemoryWriteSource,
    provenance?: SourceProvenance,
  ): void;

  /** Returns the named section's body, or null if file or section is absent. */
  readSection(section: string): string | null;

  /** Source labels for the current contents of one durable memory section. */
  provenanceForSection(section: string, content?: string): SourceProvenance;

  /**
   * Renames `from` section to `to`. Lossless:
   * - "renamed": `from` existed, `to` did not — header rewritten in place.
   * - "noop":    file missing or `from` not present.
   * - "merged":  both `from` and `to` exist — bodies concatenated under `to`,
   *              `from` block removed.
   */
  renameSection(
    from: string,
    to: string,
    source?: MemoryWriteSource,
  ): "renamed" | "noop" | "merged";

  /**
   * Apply multiple renames as a single read + single atomic write. Returns
   * outcomes in the order of `renames`. Used by sport migrations so a partial
   * rename cannot leave half-migrated state observable to subsequent init
   * steps.
   */
  renameSections(
    renames: ReadonlyArray<readonly [string, string]>,
    source?: MemoryWriteSource,
  ): Array<"renamed" | "noop" | "merged">;

  /** Reads today's daily-notes file (or for `date` when supplied). */
  readDailyNotes(date?: string): string;

  /** Appends a note to today's daily-notes file. */
  appendDailyNote(note: string, date?: string, provenance?: SourceProvenance): void;

  /**
   * Daily notes for every date in [from, to] (inclusive, YYYY-MM-DD), ascending,
   * skipping dates with no note file. Returns [] when either bound is not a
   * parseable date.
   */
  readDailyNotesInRange(from: string, to: string): Array<{ date: string; text: string }>;

  /** Raw contents of the append-only event ledger (memory/events.jsonl), or "" if absent. */
  readEventsRaw(): string;

  /**
   * Appends one event to the append-only event ledger
   * (`memory/events.jsonl`). Entries are never rewritten or pruned.
   */
  appendEvent(event: LedgerEventInput, provenance?: SourceProvenance): void;

  /** Persists the active training plan as JSON. */
  savePlan(plan: unknown, source?: MemoryWriteSource, provenance?: SourceProvenance): void;

  /** Loads the active training plan, or null if none. */
  loadPlan(): unknown | null;

  /** Source labels bound to the exact visible result of a synchronous tool read. */
  provenanceForToolRead?(
    name: string,
    input: unknown,
    visibleResult?: unknown,
    opts?: { truncated?: boolean },
  ): SourceProvenance;

  /** Sync point invoked after compaction or memory flush. */
  reload(): void;

  /**
   * Composed string Core feeds into the system prompt's Athlete Context.
   * With no `opts`, returns the full store (the memory_read path). Sections
   * named in `excludeSections` (spec'd with `inject === false`) are dropped
   * from the Athlete Memory part; orphan sections are never in the exclude
   * set and always inject.
   */
  getContext(opts?: { excludeSections?: readonly string[] }): string;
}

export interface MemorySnapshot {
  /** Returns section content, or null if section is empty/absent. */
  read(sectionName: string): string | null;

  /** True if the section exists and has non-empty content. */
  has(sectionName: string): boolean;

  /** All section names visible in this snapshot. */
  listSections(): readonly string[];

  /** Source labels attached to the frozen section contents. */
  provenanceOf(sectionName: string): SourceProvenance;
}
