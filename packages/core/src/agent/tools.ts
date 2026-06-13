import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MemorySectionSpec } from "../sport.js";
import type { MemoryStore } from "../memory.js";
import { isRealDateKey, parseDateKeyMs, MS_PER_DAY } from "../io/date-keys.js";

function buildMemoryWriteDescription(sections: readonly MemorySectionSpec[]): string {
  const sectionList = sections.map((s) => `${s.name} (${s.description})`).join("; ");
  return (
    "Write to long-term memory (replaces section content) or daily notes. " +
    `Sections: ${sectionList}.`
  );
}

export function createMemoryReadTool(memory: MemoryStore) {
  return tool({
    description: "Read long-term athlete memory, today's notes, and current plan state",
    inputSchema: zodSchema(z.object({})),
    execute: async () => memory.getContext() || "No athlete data stored yet.",
  });
}

const MEMORY_QUERY_MAX_RANGE_DAYS = 366;
const MEMORY_QUERY_MAX_RESULT_CHARS = 20_000;
const MEMORY_QUERY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function createMemoryQueryTool(memory: MemoryStore) {
  return tool({
    description:
      "Query dated athlete memory: daily notes and the event ledger over a date range. " +
      "Use this for any question about past notes, decisions, overrides, illness, or " +
      "experiments. Returns matching notes and events grouped by date.",
    inputSchema: zodSchema(
      z.object({
        from: z
          .string()
          .regex(MEMORY_QUERY_DATE_RE)
          .describe("Start date (inclusive), YYYY-MM-DD"),
        to: z
          .string()
          .regex(MEMORY_QUERY_DATE_RE)
          .describe("End date (inclusive), YYYY-MM-DD"),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring filter. Omit to return everything in the range."),
      }),
    ),
    execute: async (input: { from: string; to: string; query?: string }) => {
      const { from, to, query } = input;
      if (!isRealDateKey(from) || !isRealDateKey(to)) {
        return `Error: ${from}..${to} contains an invalid calendar date. Use real YYYY-MM-DD dates.`;
      }
      if (from > to) {
        return `Error: 'from' (${from}) is after 'to' (${to}). Swap the bounds.`;
      }
      const rangeDays = (parseDateKeyMs(to) - parseDateKeyMs(from)) / MS_PER_DAY + 1;
      if (rangeDays > MEMORY_QUERY_MAX_RANGE_DAYS) {
        return `Error: range is ${rangeDays} days; the maximum is ${MEMORY_QUERY_MAX_RANGE_DAYS}. Query a narrower range.`;
      }

      const q = query?.toLowerCase();
      const byDate = new Map<string, string[]>();

      for (const { date, text } of memory.readDailyNotesInRange(from, to)) {
        const lines = q
          ? text.split("\n").filter((l) => l.toLowerCase().includes(q))
          : [text];
        if (lines.length > 0) byDate.set(date, lines);
      }

      for (const line of memory.readEventsRaw().split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const date = (parsed as { date?: unknown }).date;
        if (typeof date !== "string" || date < from || date > to) continue;
        if (q && !trimmed.toLowerCase().includes(q)) continue;
        const bucket = byDate.get(date) ?? [];
        bucket.push(`event: ${trimmed}`);
        byDate.set(date, bucket);
      }

      const header = `Memory query ${from}..${to}` + (query ? ` matching "${query}"` : "");
      if (byDate.size === 0) {
        return `${header}: no daily notes or events found.`;
      }
      const sections = [...byDate.keys()]
        .sort()
        .map((d) => `## ${d}\n${byDate.get(d)!.join("\n")}`);
      const result = [header, ...sections].join("\n\n");
      return result.length > MEMORY_QUERY_MAX_RESULT_CHARS
        ? result.slice(0, MEMORY_QUERY_MAX_RESULT_CHARS) +
            "\n[truncated — narrow the date range or add a query term]"
        : result;
    },
  });
}

export function createMemoryTools(
  memory: MemoryStore,
  sections: readonly MemorySectionSpec[],
) {
  if (sections.length === 0) {
    throw new Error(
      "createMemoryTools requires at least one MemorySectionSpec. " +
        "Pass getEffectiveSections(sport) — Core's shared sections guarantee non-empty.",
    );
  }
  const sectionNames = sections.map((s) => s.name) as [string, ...string[]];
  return {
    memory_read: createMemoryReadTool(memory),
    memory_query: createMemoryQueryTool(memory),

    memory_write: tool({
      description: buildMemoryWriteDescription(sections),
      inputSchema: zodSchema(
        z.object({
          type: z
            .enum(["memory", "daily"])
            .describe("'memory' for long-term facts, 'daily' for today's notes"),
          section: z
            .enum(sectionNames)
            .optional()
            .describe(
              "Memory section to write to (required when type='memory'). Replaces the section content.",
            ),
          content: z.string().describe("The information to save"),
        }),
      ),
      execute: async (input: { type: "memory" | "daily"; section?: string; content: string }) => {
        if (input.type === "memory") {
          // "notes" is a CORE_SHARED_SECTIONS catch-all — safe default when the LLM forgets to pick a section.
          memory.writeSection(input.section ?? "notes", input.content, "chat-tool");
        } else {
          memory.appendDailyNote(input.content);
        }
        return { saved: true };
      },
    }),

    plan_save: tool({
      description: "Save or update the current training plan",
      inputSchema: zodSchema(
        z.object({
          plan: z.record(z.string(), z.unknown()).describe("The training plan object to save"),
        }),
      ),
      execute: async (input: { plan: Record<string, unknown> }) => {
        memory.savePlan(input.plan, "chat-tool");
        return { saved: true };
      },
    }),

    plan_load: tool({
      description: "Load the current active training plan",
      inputSchema: zodSchema(z.object({})),
      execute: async () => memory.loadPlan() ?? { message: "No plan saved yet." },
    }),
  };
}
