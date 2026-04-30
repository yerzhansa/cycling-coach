import type { MemorySnapshot, MemoryStore } from "@enduragent/core";

/**
 * Wraps a MemoryStore in a frozen-at-call-time read-only sectioned view.
 *
 * Sport.mustPreserveTokens (function form) takes this view to derive
 * data-bound tokens (e.g. "FTP 247W") from the current memory state.
 *
 * Sections are parsed from MEMORY.md's `## name` headers — see the
 * Memory class's writeSection() format.
 */
export function createMemorySnapshot(store: MemoryStore): MemorySnapshot {
  const sections = parseSectionsFromMarkdown(store.readMemory());
  return {
    read(name: string): string | null {
      const body = sections.get(name);
      return body && body.length > 0 ? body : null;
    },
    has(name: string): boolean {
      const body = sections.get(name);
      return body !== undefined && body.length > 0;
    },
    listSections(): readonly string[] {
      return Array.from(sections.keys());
    },
  };
}

function parseSectionsFromMarkdown(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  if (!content) return sections;
  // Split on lines starting with "## " (section headers).
  const parts = content.split(/^## /m);
  for (const raw of parts) {
    if (!raw.trim()) continue;
    const newline = raw.indexOf("\n");
    const name = (newline >= 0 ? raw.slice(0, newline) : raw).trim();
    const body = (newline >= 0 ? raw.slice(newline + 1) : "").trim();
    sections.set(name, body);
  }
  return sections;
}
