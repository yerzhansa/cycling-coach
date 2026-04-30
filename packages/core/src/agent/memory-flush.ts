import { tool, zodSchema, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { z } from "zod";
import type { MemorySectionSpec } from "../sport.js";
import type { MemoryStore } from "../memory.js";
import { createMemoryReadTool } from "./tools.js";
import type { LLM } from "../llm.js";

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
  // The transitional migration clause helps the LLM redistribute legacy
  // content (chronic facts in cycling-history, body data in cycling-profile)
  // to the right destinations after the section rename.
  // TODO(wave-2-cleanup): remove this clause and the surrounding text
  // when the `chronic_facts_stuck_in_cycling_history` log event has been
  // silent for ~30 days post-deploy. Saves ~40 input tokens per flush.
  return `Review this conversation and save athlete details to structured memory
sections. First read existing memory with memory_read, then write each
section that has new or updated information.

Write to these sections using memory_write:
${sectionList}

For each section you write, include ALL current facts for that section
(both from memory and from the conversation). This fully replaces the
section content — omitted facts will be lost.

Note (transitional, post-migration): if \`cycling-profile\` contains weight,
age, or available training days, move them to \`person\`. If \`cycling-history\`
contains chronic conditions or long-term medications (hypertension, lisinopril,
diabetes), move them to \`medical-history\`.

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
// CHRONIC-KEYWORD CONVERGENCE SCAN
// ============================================================================

// Substring matches against `cycling-history` body after each flush. Fires a
// structured warn if chronic content (which belongs in `medical-history`) is
// still parked in cycling-history — observability for the Wave 2 migration's
// "convergence over 1-3 flushes" assumption from ADR-0003. Substring matching
// is intentional (catches plurals like "medications" via "medication"); expand
// the list as we observe real data.
const CHRONIC_KEYWORDS = [
  "hypertension",
  "diabetes",
  "asthma",
  "chronic",
  "lisinopril",
  "metformin",
  "statins",
  "long-term",
  "medication",
] as const;

function scanForStuckChronic(memory: MemoryStore): void {
  const cyclingHistory = memory.readSection("cycling-history");
  if (!cyclingHistory) return;
  const lower = cyclingHistory.toLowerCase();
  const matches = CHRONIC_KEYWORDS.filter((k) => lower.includes(k));
  if (matches.length === 0) return;
  console.warn(
    JSON.stringify({
      event: "chronic_facts_stuck_in_cycling_history",
      keywords: matches,
      hint: "Run another memory_flush; if persists, manually move to medical-history",
    }),
  );
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
  if (params.memorySections.length === 0) {
    throw new Error(
      "runMemoryFlush requires at least one memory section. " +
        "Pass getEffectiveSections(sport) — Core's shared sections guarantee non-empty.",
    );
  }
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
  scanForStuckChronic(params.memory);
}
