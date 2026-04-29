import { tool, zodSchema, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { MemorySectionSpec, MemoryStore } from "@cycling-coach/core";
import { createMemoryReadTool } from "./tools.js";
import type { LLM } from "./llm.js";

// ============================================================================
// CONSTANTS
// ============================================================================

export const SOFT_THRESHOLD_RATIO = 0.8;

// ============================================================================
// PROMPTS
// ============================================================================

const MEMORY_FLUSH_SYSTEM_PROMPT = `You are reviewing a conversation to extract and save important athlete
information before it is summarized. Use the memory_write tool to save
details into the appropriate section. Each section is fully replaced on
write, so include ALL current facts for that section, not just new ones.`;

function buildFlushUserPrompt(sections: readonly MemorySectionSpec[]): string {
  const sectionList = sections.map((s) => `- "${s.name}": ${s.description}`).join("\n");
  return `Review this conversation and save athlete details to structured memory
sections. First read existing memory with memory_read, then write each
section that has new or updated information.

Write to these sections using memory_write:
${sectionList}

For each section you write, include ALL current facts for that section
(both from memory and from the conversation). This fully replaces the
section content — omitted facts will be lost.

Only write sections that have new or changed information.`;
}

// ============================================================================
// APPEND-ONLY MEMORY WRITE TOOL
// ============================================================================

function createFlushMemoryWriteTool(memory: MemoryStore, sections: readonly MemorySectionSpec[]) {
  const sectionNames = sections.map((s) => s.name) as [string, ...string[]];
  return tool({
    description: "Write to a memory section (replaces entire section content)",
    inputSchema: zodSchema(
      z.object({
        section: z.enum(sectionNames).describe("Which section to write"),
        content: z.string().describe("Complete section content — include ALL facts for this section"),
      }),
    ),
    execute: async (input: { section: string; content: string }) => {
      memory.writeSection(input.section, input.content);
      return { saved: true };
    },
  });
}

// ============================================================================
// MEMORY FLUSH
// ============================================================================

export async function runMemoryFlush(params: {
  llm: LLM;
  messages: ModelMessage[];
  memory: MemoryStore;
  memorySections: readonly MemorySectionSpec[];
}): Promise<void> {
  const flushTools = {
    memory_write: createFlushMemoryWriteTool(params.memory, params.memorySections),
    memory_read: createMemoryReadTool(params.memory),
  };

  await params.llm.generate({
    system: MEMORY_FLUSH_SYSTEM_PROMPT,
    messages: [
      ...params.messages,
      { role: "user" as const, content: buildFlushUserPrompt(params.memorySections) },
    ],
    tools: flushTools,
    stopWhen: stepCountIs(5),
    maxSteps: 5,
  });

  params.memory.reload();
}
