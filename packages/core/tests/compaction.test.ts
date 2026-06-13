import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import type { MemorySnapshot } from "@enduragent/core";
import {
  auditSummaryQuality,
  summarizeDroppedMessages,
  summarizeInStages,
} from "../src/agent/compaction.js";
import { makeSummaryMessage, SUMMARY_PREFIX } from "../src/agent/history-limit.js";
import { createFakeLLM } from "./helpers/fake-llm.js";

// ─── Test helpers ─────────────────────────────────────────────────────

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

const VALID_FIVE_SECTION_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg, training Mon/Wed/Fri",
  "## Training Status",
  "- Build phase, target FTP 280W",
  "## Coach Stance",
  "- Hold volume this week (prior knee issue); athlete has not pushed back",
  "## Discussion Context",
  "- Goal-setting and equipment review",
  "## Pending Questions",
  "- None outstanding",
].join("\n");

import { CYCLING_VOCABULARY } from "@enduragent/sport-cycling";

const EMPTY_SNAPSHOT: MemorySnapshot = {
  read: () => null,
  has: () => false,
  listSections: () => [],
};

// ─── Compaction smoke test ────────────────────────────────────────────
//
// After commit 5 the MUST-PRESERVE block is parameterized against
// `sport.mustPreserveTokens`. The test passes the cycling vocabulary
// directly so the assertions don't depend on cyclingSport's runtime
// state.

describe("compaction (sport-parameterized)", () => {
  it("summarizeDroppedMessages prompt carries MUST-PRESERVE + sport tokens + transcript data", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY], { repeatLast: true });

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(spy.capturedPrompts.length).toBeGreaterThan(0);
    const prompt = spy.capturedPrompts[0];

    // Hard contract: every compaction prompt carries the MUST-PRESERVE
    // instruction.
    expect(prompt).toContain("MUST PRESERVE");

    // Sport-vocabulary tokens flow through.
    expect(prompt).toContain("FTP");
    expect(prompt).toContain("W/kg");
    expect(prompt).toContain("Coggan");

    // Transcript data is included verbatim.
    expect(prompt).toContain("247W");
    expect(prompt).toContain("72kg");

    expect(prompt).toContain("## Coach Stance");
    expect(prompt).toContain("stance per axis");
    expect(prompt).toContain("currently disputing");
    expect(prompt).toContain("illness or symptoms");
    expect(prompt).toContain("agreed but not yet executed");
  });

  it("summarizeDroppedMessages with function-form tokens calls the function with the snapshot", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY], { repeatLast: true });
    const calls: MemorySnapshot[] = [];

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: (snap) => {
        calls.push(snap);
        return ["FTP 247W", "DYNAMIC_TOKEN"];
      },
      memory: EMPTY_SNAPSHOT,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(EMPTY_SNAPSHOT);
    expect(spy.capturedPrompts[0]).toContain("FTP 247W");
    expect(spy.capturedPrompts[0]).toContain("DYNAMIC_TOKEN");
  });

  it("summarizeInStages prompt also carries the MUST-PRESERVE instruction and tokens", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY], { repeatLast: true });

    await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(spy.capturedPrompts.length).toBeGreaterThan(0);
    expect(spy.capturedPrompts[0]).toContain("MUST PRESERVE");
    expect(spy.capturedPrompts[0]).toContain("FTP");

    expect(spy.capturedPrompts[0]).toContain("## Coach Stance");
    expect(spy.capturedPrompts[0]).toContain("stance per axis");
    expect(spy.capturedPrompts[0]).toContain("currently disputing");
    expect(spy.capturedPrompts[0]).toContain("illness or symptoms");
    expect(spy.capturedPrompts[0]).toContain("agreed but not yet executed");
  });

  it("auditSummaryQuality accepts a summary with all five required sections", () => {
    const audit = auditSummaryQuality(VALID_FIVE_SECTION_SUMMARY);
    expect(audit.ok).toBe(true);
    expect(audit.missing).toEqual([]);
  });

  it("auditSummaryQuality flags a summary missing required sections", () => {
    const partial = "## Athlete Profile\n- FTP 247W\n## Discussion Context\n- foo";
    const audit = auditSummaryQuality(partial);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toContain("## Training Status");
    expect(audit.missing).toContain("## Coach Stance");
    expect(audit.missing).toContain("## Pending Questions");
  });

  it("auditSummaryQuality flags a summary missing only ## Coach Stance", () => {
    const fourSection = [
      "## Athlete Profile",
      "- FTP 247W",
      "## Training Status",
      "- Build phase",
      "## Discussion Context",
      "- Goal review",
      "## Pending Questions",
      "- None",
    ].join("\n");
    const audit = auditSummaryQuality(fourSection);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual(["## Coach Stance"]);
  });
});

describe("summarizeDroppedMessages failure containment", () => {
  it("throws when every chunk fails", async () => {
    const llm = createFakeLLM([{ error: new Error("boom") }], { repeatLast: true });

    await expect(
      summarizeDroppedMessages({
        dropped: REPRESENTATIVE_CONVERSATION,
        llm,
        mustPreserveTokens: [],
        memory: EMPTY_SNAPSHOT,
      }),
    ).rejects.toThrow("Dropped message summarization failed for every chunk");
  });

  it("requeues the failed chunk's messages when one chunk fails", async () => {
    const firstMessage: ModelMessage = { role: "user", content: "CHUNK-A " + "a".repeat(20_000) };
    const secondMessage: ModelMessage = { role: "user", content: "CHUNK-B " + "b".repeat(20_000) };
    const llm = createFakeLLM([{ error: new Error("boom") }, VALID_FIVE_SECTION_SUMMARY]);

    const result = await summarizeDroppedMessages({
      dropped: [firstMessage, secondMessage],
      llm,
      mustPreserveTokens: [],
      memory: EMPTY_SNAPSHOT,
      contextWindowTokens: 30_000,
    });

    expect(result.unsummarized).toEqual([firstMessage]);
    expect(result.summary).toContain("## Coach Stance");
  });

  it("returns an empty requeue on success", async () => {
    const llm = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);

    const result = await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm,
      mustPreserveTokens: [],
      memory: EMPTY_SNAPSHOT,
    });

    expect(result.unsummarized).toEqual([]);
    expect(result.summary).toContain("## Coach Stance");
  });

  it("short-circuits empty dropped without an LLM call", async () => {
    const llm = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);

    const result = await summarizeDroppedMessages({
      dropped: [],
      llm,
      mustPreserveTokens: [],
      memory: EMPTY_SNAPSHOT,
      previousSummary: "prior",
    });

    expect(result).toEqual({ summary: "prior", unsummarized: [] });
    expect(llm.capturedPrompts).toHaveLength(0);
  });
});

describe("shared audit post-step (cap-before-audit)", () => {
  const PREVIOUS_SUMMARY = "## Athlete Profile\n- FTP 247W baseline established";

  it("staged summarization retries a sectionless summary and returns the restructured one", async () => {
    const spy = createFakeLLM(["just some unstructured text", VALID_FIVE_SECTION_SUMMARY]);

    const result = await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(spy.capturedPrompts).toHaveLength(2);
    expect(spy.capturedPrompts[1]).toContain("Restructure the following summary");
    for (const opts of spy.capturedOpts) {
      expect(opts.maxOutputTokens).toBe(1000);
    }
    expect(result[0].content).toContain("## Coach Stance");
    expect(result[0].content).toContain("## Pending Questions");
    expect(result).toHaveLength(3);
  });

  it("staged summarization that stays sectionless degrades to the capped text instead of throwing", async () => {
    const spy = createFakeLLM(["no sections here", "still no sections"]);

    const result = await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(spy.capturedPrompts).toHaveLength(2);
    expect(result[0].content).toContain("still no sections");
    expect(result).toHaveLength(3);
  });

  it("audits the capped text, not the pre-cap text: tail-amputated sections trigger the retry", async () => {
    const tailBeyondCap =
      "## Athlete Profile\n- FTP 247W\n" +
      "x".repeat(4100) +
      "\n## Training Status\n## Coach Stance\n## Discussion Context\n## Pending Questions";
    const spy = createFakeLLM([tailBeyondCap, VALID_FIVE_SECTION_SUMMARY]);

    const { summary, unsummarized } = await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(spy.capturedPrompts).toHaveLength(2);
    expect(summary).toBe(VALID_FIVE_SECTION_SUMMARY);
    expect(unsummarized).toEqual([]);
  });

  it("every summarization call carries the 1000-token generation bound", async () => {
    const spy = createFakeLLM(["sectionless", "still sectionless"]);

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(spy.capturedOpts.length).toBeGreaterThanOrEqual(2);
    for (const opts of spy.capturedOpts) {
      expect(opts.maxOutputTokens).toBe(1000);
    }
  });

  it("a leading summary message reaches summarizeInStages as previousSummary, not as a transcript line", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY]);

    await summarizeInStages({
      messages: [makeSummaryMessage(PREVIOUS_SUMMARY), ...REPRESENTATIVE_CONVERSATION],
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    const prompt = spy.capturedPrompts[0];
    expect(prompt).toContain("Existing summary of earlier context:");
    expect(prompt).toContain("FTP 247W baseline established");
    expect(prompt).not.toContain(`system: ${SUMMARY_PREFIX}`);
  });

  it("both update prompts carry the PRESERVE-prior-summary rule", async () => {
    const spy = createFakeLLM([VALID_FIVE_SECTION_SUMMARY, VALID_FIVE_SECTION_SUMMARY]);

    await summarizeDroppedMessages({
      dropped: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      previousSummary: PREVIOUS_SUMMARY,
    });
    await summarizeInStages({
      messages: REPRESENTATIVE_CONVERSATION,
      llm: spy,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(spy.capturedPrompts[0]).toContain("PRESERVE every fact in it");
    expect(spy.capturedPrompts[1]).toContain("PRESERVE every fact in it");
  });
});
