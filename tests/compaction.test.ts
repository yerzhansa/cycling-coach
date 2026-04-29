import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  auditSummaryQuality,
  summarizeDroppedMessages,
  summarizeInStages,
} from "../src/agent/compaction.js";
import type { LLM } from "../src/agent/llm.js";

// ─── Test helpers ─────────────────────────────────────────────────────

interface SpyLLM extends LLM {
  capturedPrompts: string[];
  capturedMessages: ModelMessage[][];
}

function createSpyLLM(response: string): SpyLLM {
  const capturedPrompts: string[] = [];
  const capturedMessages: ModelMessage[][] = [];
  const spy = {
    capturedPrompts,
    capturedMessages,
    async generate(opts: { prompt?: string; messages?: ModelMessage[] }) {
      if (opts.prompt !== undefined) capturedPrompts.push(opts.prompt);
      if (opts.messages !== undefined) capturedMessages.push(opts.messages);
      return {
        text: response,
        toolCalls: [],
        finishReason: "stop" as const,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      };
    },
  };
  return spy as unknown as SpyLLM;
}

const REPRESENTATIVE_CONVERSATION: ModelMessage[] = [
  { role: "user", content: "My FTP is 247W and I weigh 72kg." },
  { role: "assistant", content: "Got it. Logging FTP=247W, weight=72kg." },
  { role: "user", content: "I train Monday, Wednesday, and Friday." },
  { role: "assistant", content: "Schedule noted: Mon/Wed/Fri." },
  { role: "user", content: "Goal: lift FTP to 280W by August for the Gran Fondo." },
  { role: "assistant", content: "Target: FTP 280W by 2026-08, race type gran_fondo." },
  { role: "user", content: "Bike is Trek Madone, power meter is Quarq DZero." },
  { role: "assistant", content: "Equipment logged." },
  { role: "user", content: "I had a knee issue last winter; it flares with high volume." },
  { role: "assistant", content: "Health note: prior knee issue, watch high-volume blocks." },
];

const VALID_FOUR_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg, training Mon/Wed/Fri",
  "## Training Status",
  "- Build phase, target FTP 280W",
  "## Discussion Context",
  "- Goal-setting and equipment review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

// ─── Compaction smoke test (Wave 1 commit 4 baseline) ─────────────────
//
// Establishes the pre-parameterization baseline for compaction's
// must-preserve behavior. Commit 5 parameterizes the MUST_PRESERVE block
// against `sport.mustPreserveTokens`; this test should still pass after
// that change because cyclingSport's vocabulary list overlaps with the
// existing categorical instructions ("FTP", "W/kg" → still appear in
// the prompt; the wording "athlete profile details" gets replaced by
// the explicit token list).

describe("compaction (baseline before sport parameterization)", () => {
  it("summarizeDroppedMessages prompt instructs the LLM to preserve athlete data", async () => {
    const spy = createSpyLLM(VALID_FOUR_SECTION_SUMMARY);

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
    });

    expect(spy.capturedPrompts.length).toBeGreaterThan(0);
    const prompt = spy.capturedPrompts[0];

    // Hard contract: every compaction prompt must carry the
    // MUST-PRESERVE instruction.
    expect(prompt).toContain("MUST PRESERVE");

    // Loose contract: today the prompt enumerates categories ("FTP, weight,
    // experience, schedule, goals"). After commit 5 it will enumerate
    // explicit tokens from `cyclingSport.mustPreserveTokens` instead. Either
    // way, the FTP token and the user's actual data must surface.
    expect(prompt).toContain("FTP");
    expect(prompt).toContain("247W");
    expect(prompt).toContain("72kg");
  });

  it("summarizeInStages prompt also carries the MUST-PRESERVE instruction", async () => {
    const spy = createSpyLLM(VALID_FOUR_SECTION_SUMMARY);

    await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      recentToKeep: 2,
    });

    expect(spy.capturedPrompts.length).toBeGreaterThan(0);
    expect(spy.capturedPrompts[0]).toContain("MUST PRESERVE");
  });

  it("auditSummaryQuality accepts a summary with all four required sections", () => {
    const audit = auditSummaryQuality(VALID_FOUR_SECTION_SUMMARY);
    expect(audit.ok).toBe(true);
    expect(audit.missing).toEqual([]);
  });

  it("auditSummaryQuality flags a summary missing required sections", () => {
    const partial = "## Athlete Profile\n- FTP 247W\n## Discussion Context\n- foo";
    const audit = auditSummaryQuality(partial);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toContain("## Training Status");
    expect(audit.missing).toContain("## Pending Questions");
  });
});
