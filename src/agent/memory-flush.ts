import { generateText, tool, zodSchema, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage } from "ai";
import { z } from "zod";
import type { Memory } from "./memory.js";
import { createMemoryReadTool } from "./tools.js";

// ============================================================================
// CONSTANTS
// ============================================================================

export const SOFT_THRESHOLD_RATIO = 0.8;

// ============================================================================
// PROMPTS
// ============================================================================

const MEMORY_FLUSH_SYSTEM_PROMPT = `You are reviewing a conversation to extract and save important information
before it is summarized. Use the memory_write tool to save any athlete
details that are not already in memory.`;

const MEMORY_FLUSH_USER_PROMPT = `Review this conversation and save any athlete details not already in
long-term memory. Focus on:
- Personal metrics (FTP, weight, max HR, resting HR)
- Training schedule and availability
- Goals, target events, and race dates
- Injuries, limitations, or recovery needs
- Equipment and trainer/outdoor preferences
- Past training history and experience level

Only save facts not already in memory. Use memory_write with type "memory"
for each distinct piece of information.`;

// ============================================================================
// APPEND-ONLY MEMORY WRITE TOOL
// ============================================================================

function createAppendOnlyMemoryWriteTool(memory: Memory) {
  return tool({
    description: "Append to long-term athlete memory (append-only during memory flush)",
    inputSchema: zodSchema(
      z.object({
        content: z.string().describe("The information to save"),
      }),
    ),
    execute: async (input: { content: string }) => {
      memory.appendMemory(input.content);
      return { saved: true };
    },
  });
}

// ============================================================================
// MEMORY FLUSH
// ============================================================================

export async function runMemoryFlush(params: {
  model: LanguageModel;
  messages: ModelMessage[];
  memory: Memory;
}): Promise<void> {
  const flushTools = {
    memory_write: createAppendOnlyMemoryWriteTool(params.memory),
    memory_read: createMemoryReadTool(params.memory),
  };

  await generateText({
    model: params.model,
    system: MEMORY_FLUSH_SYSTEM_PROMPT,
    messages: [
      ...params.messages,
      { role: "user" as const, content: MEMORY_FLUSH_USER_PROMPT },
    ],
    tools: flushTools,
    stopWhen: stepCountIs(5),
  });

  params.memory.reload();
}

