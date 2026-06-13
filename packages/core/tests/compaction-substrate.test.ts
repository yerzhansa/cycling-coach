import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import type { MemorySnapshot } from "@enduragent/core";
import {
  summarizeDroppedMessages,
  summarizeInStages,
  chunkMessagesByMaxTokens,
  computeAdaptiveChunkRatio,
} from "../src/agent/compaction.js";
import {
  makeSummaryMessage,
  splitHistoryByBudget,
} from "../src/agent/history-limit.js";
import { ChatStore } from "../src/agent/chat-store.js";
import { createFakeLLM } from "./helpers/fake-llm.js";
import { CYCLING_VOCABULARY } from "@enduragent/sport-cycling";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "cc-substrate-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const EMPTY_SNAPSHOT: MemorySnapshot = {
  read: () => null,
  has: () => false,
  listSections: () => [],
};

const CONVERSATION: ModelMessage[] = [
  { role: "user", content: "My FTP is 247W and I weigh 72kg." },
  { role: "assistant", content: "Got it. Logging FTP=247W, weight=72kg." },
  { role: "user", content: "I train Monday, Wednesday, and Friday." },
  { role: "assistant", content: "Schedule noted: Mon/Wed/Fri." },
  { role: "user", content: "Goal: lift FTP to 280W by August for the Gran Fondo." },
  { role: "assistant", content: "Target: FTP 280W, race type gran_fondo." },
  { role: "user", content: "Bike is Trek Madone, power meter is Quarq DZero." },
  { role: "assistant", content: "Equipment logged." },
  { role: "user", content: "I had a knee issue last winter; it flares with high volume." },
  { role: "assistant", content: "Health note: prior knee issue, watch high-volume blocks." },
];

const STANCE_FACT = "holding weekly volume at 8h; athlete disputes and asked for 12h";

const STANCE_SUMMARY = [
  "## Athlete Profile",
  "- FTP 247W, 72kg, Mon/Wed/Fri schedule. " + "Long-standing base notes. ".repeat(20),
  "## Training Status",
  "- Build phase, target FTP 280W by August",
  "## Coach Stance",
  `- ${STANCE_FACT}`,
  "## Discussion Context",
  "- Weekly volume negotiation",
  "## Pending Questions",
  "- Athlete to confirm available hours on Friday",
].join("\n");

const msg = (chars: number): ModelMessage => ({ role: "user", content: "x".repeat(chars) });

describe("chunkMessagesByMaxTokens", () => {
  it("returns no chunks for an empty message list", () => {
    expect(chunkMessagesByMaxTokens([], 300)).toEqual([]);
  });

  it("packs greedily under the safety-margin budget and preserves order", () => {
    const messages = [msg(400), msg(400), msg(400), msg(400), msg(400)];
    const chunks = chunkMessagesByMaxTokens(messages, 300);
    expect(chunks.map((c) => c.length)).toEqual([2, 2, 1]);
    expect(chunks.flat()).toEqual(messages);
  });

  it("gives an oversized message its own chunk instead of dropping it", () => {
    const messages = [msg(400), msg(400)];
    const chunks = chunkMessagesByMaxTokens(messages, 60);
    expect(chunks.map((c) => c.length)).toEqual([1, 1]);
    expect(chunks.flat()).toEqual(messages);
  });
});

describe("computeAdaptiveChunkRatio", () => {
  it("returns the 0.4 base ratio for empty input and for small messages", () => {
    expect(computeAdaptiveChunkRatio([], 200_000)).toBe(0.4);
    expect(computeAdaptiveChunkRatio([msg(40)], 200_000)).toBe(0.4);
  });

  it("reduces the ratio once the average message dominates the window", () => {
    expect(computeAdaptiveChunkRatio([msg(4000)], 12_000)).toBeCloseTo(0.16, 10);
  });

  it("never drops below the 0.15 floor", () => {
    expect(computeAdaptiveChunkRatio([msg(4000)], 10_000)).toBeCloseTo(0.15, 10);
  });
});

describe("summary capping through the trim pipeline", () => {
  it("caps an oversized summary at 4000 chars with the truncation marker", async () => {
    const headings =
      "## Athlete Profile\n- FTP 247W\n## Training Status\n- Build\n## Coach Stance\n- Hold volume\n## Discussion Context\n- Goals\n## Pending Questions\n- None\n";
    const oversized = headings + "z".repeat(8000);
    const llm = createFakeLLM([oversized]);

    const { summary, unsummarized } = await summarizeDroppedMessages({
      dropped: CONVERSATION,
      llm,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(unsummarized).toEqual([]);
    expect(llm.capturedPrompts).toHaveLength(1);
    expect(summary.length).toBe(4000 + "\n\n[Summary truncated]".length);
    expect(summary.endsWith("[Summary truncated]")).toBe(true);
    expect(summary).toContain("## Pending Questions");
  });
});

describe("coach-stance round-trip (mechanical path)", () => {
  it("a stance fact survives trim, persistence, extraction, and re-entry into the next prompt", async () => {
    const llm1 = createFakeLLM([STANCE_SUMMARY]);
    const { summary, unsummarized } = await summarizeDroppedMessages({
      dropped: CONVERSATION,
      llm: llm1,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });

    expect(unsummarized).toEqual([]);
    expect(summary).toContain(STANCE_FACT);

    const store = new ChatStore(dataDir);
    store.overwriteHistory("rt", [
      makeSummaryMessage(summary),
      { role: "user", content: "kept tail message" },
    ]);
    const { messages } = store.load("rt");
    const split = splitHistoryByBudget({ messages, tokenBudget: 100_000 });
    expect(split.previousSummary).toBe(summary);
    expect(split.kept).toEqual([{ role: "user", content: "kept tail message" }]);

    const llm2 = createFakeLLM([STANCE_SUMMARY]);
    await summarizeDroppedMessages({
      dropped: [{ role: "user", content: "another old message about cadence" }],
      previousSummary: split.previousSummary,
      llm: llm2,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
    });
    expect(llm2.capturedPrompts[0]).toContain("Existing summary of earlier context:");
    expect(llm2.capturedPrompts[0]).toContain(STANCE_FACT);
  });

  it("a stance fact in a leading summary survives the in-turn pipeline into the carried summary", async () => {
    const llm = createFakeLLM([STANCE_SUMMARY]);
    const result = await summarizeInStages({
      messages: [makeSummaryMessage(STANCE_SUMMARY), ...CONVERSATION],
      llm,
      mustPreserveTokens: CYCLING_VOCABULARY,
      memory: EMPTY_SNAPSHOT,
      recentToKeep: 2,
    });

    expect(llm.capturedPrompts).toHaveLength(1);
    expect(llm.capturedPrompts[0]).toContain(STANCE_FACT);
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("system");
    expect(String(result[0].content)).toContain(STANCE_FACT);
  });
});
