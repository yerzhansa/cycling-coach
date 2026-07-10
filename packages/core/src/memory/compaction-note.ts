import type { MemoryStore } from "../memory.js";

export const COMPACTION_SUMMARY_MARKER = "### Compaction summary";

export function demoteSummaryHeadings(summary: string): string {
  return summary.replace(/^## (?!#)/gm, "#### ");
}

export function formatCompactionNote(summary: string): string {
  return `${COMPACTION_SUMMARY_MARKER}\n\n${demoteSummaryHeadings(summary)}`;
}

export function persistCompactionSummary(
  memory: Pick<MemoryStore, "appendDailyNote">,
  summary: string,
): void {
  if (summary.trim() === "") return;
  memory.appendDailyNote(formatCompactionNote(summary));
}
