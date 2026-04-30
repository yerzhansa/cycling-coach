import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { MemorySectionSpec } from "../sport.js";
import type { MemoryStore } from "../memory.js";

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
          memory.writeSection(input.section ?? "notes", input.content);
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
        memory.savePlan(input.plan);
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
