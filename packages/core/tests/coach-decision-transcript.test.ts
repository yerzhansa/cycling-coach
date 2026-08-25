import { writeSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatStore } from "../src/agent/chat-store.js";
import { ConversationStore } from "../src/agent/conversation-store.js";
import { TranscriptStore } from "../src/agent/transcript-store.js";

const roots: string[] = [];
const RESET_ID = "a".repeat(64);

function makeDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), "decision-transcript-"));
  roots.push(path);
  return path;
}

function unanswered(decisionId = "decision-1") {
  return {
    status: "unanswered" as const,
    decisionId,
    chatId: "desktop",
    messageId: "message-1",
    question: "Choose tomorrow's priority.",
    options: [
      {
        id: "recovery",
        label: "Prioritize recovery",
        description: "Protect the weekend session.",
        recommended: true,
        consequence: "Tomorrow becomes an easy day.",
      },
      {
        id: "tempo",
        label: "Keep tempo",
        description: "Keep the planned session.",
        recommended: false,
        consequence: "Tomorrow keeps the tempo session.",
      },
    ],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TranscriptStore coach decisions", () => {
  it("persists lifecycle entries in order and makes terminal writes idempotent", () => {
    const store = new TranscriptStore(makeDataDir());
    const requested = {
      decision: unanswered(),
      turnId: "turn-decision",
      toolCallId: "tool-1",
      athleteText: "Should I keep tomorrow's tempo session?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    };
    expect(store.appendDecisionRequested(requested)).toEqual(requested.decision);
    expect(store.appendDecisionRequested(requested)).toEqual(requested.decision);
    expect(
      store.appendDecisionRequested({
        ...requested,
        decision: {
          ...requested.decision,
          decisionId: "decision-retried",
          messageId: "message-retried",
          options: requested.decision.options.map((option, index) => ({
            ...option,
            id: `retried-${index}`,
          })),
        },
      }),
    ).toEqual(requested.decision);
    expect(store.getDecisionAthleteText("desktop", "decision-1")).toBe(
      "Should I keep tomorrow's tempo session?",
    );
    expect(() =>
      store.appendDecisionRequested({
        ...requested,
        decision: { ...requested.decision, question: "A different question?" },
      }),
    ).toThrow(/Tool call identifier/);

    const answered = store.answerDecision({
      chatId: "desktop",
      decisionId: "decision-1",
      answer: { kind: "option", optionId: "recovery" },
      consequence: "Tomorrow becomes an easy day.",
      continuationId: "continuation-1",
      answeredAt: "2026-08-24T00:01:00.000Z",
    });
    expect(answered).toMatchObject({ status: "answered", continuation: { status: "pending" } });
    expect(() =>
      store.appendDecisionRequested({
        turnId: "turn-decision",
        decision: unanswered("decision-2"),
        toolCallId: "tool-2",
        athleteText: "One more question.",
        requestedAt: "2026-08-24T00:01:30.000Z",
      }),
    ).toThrow(/already active/);
    expect(
      store.answerDecision({
        chatId: "desktop",
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "recovery" },
        consequence: "Tomorrow becomes an easy day.",
        continuationId: "continuation-1",
        answeredAt: "2026-08-24T00:02:00.000Z",
      }),
    ).toEqual(answered);
    expect(() =>
      store.skipDecision({
        chatId: "desktop",
        decisionId: "decision-1",
        skippedAt: "2026-08-24T00:03:00.000Z",
      }),
    ).toThrow(/terminal/);

    const completed = store.completeDecisionContinuation({
      chatId: "desktop",
      decisionId: "decision-1",
      continuationId: "continuation-1",
      turnId: "turn-2",
      coachText: "I kept tomorrow easy and protected the weekend.",
      lineage: {
        templateHash: "template-hash",
        assembledHash: "assembled-hash",
        provider: "openai",
        model: "gpt-test",
        lineageVersion: "1",
      },
      completedAt: "2026-08-24T00:04:00.000Z",
    });
    expect(completed).toMatchObject({
      status: "answered",
      continuation: {
        status: "completed",
        turnId: "turn-2",
        coachText: "I kept tomorrow easy and protected the weekend.",
      },
    });
    expect(
      store.completeDecisionContinuation({
        chatId: "desktop",
        decisionId: "decision-1",
        continuationId: "continuation-1",
        turnId: "turn-2",
        coachText: "I kept tomorrow easy and protected the weekend.",
        lineage: {
          templateHash: "template-hash",
          assembledHash: "assembled-hash",
          provider: "openai",
          model: "gpt-test",
          lineageVersion: "1",
        },
        completedAt: "2026-08-24T00:05:00.000Z",
      }),
    ).toEqual(completed);
    expect(() =>
      store.completeDecisionContinuation({
        chatId: "desktop",
        decisionId: "decision-1",
        continuationId: "continuation-1",
        turnId: "turn-other",
        coachText: "Conflicting duplicate payload.",
        lineage: {
          templateHash: "template-hash",
          assembledHash: "assembled-hash",
          provider: "openai",
          model: "gpt-test",
          lineageVersion: "1",
        },
        completedAt: "2026-08-24T00:06:00.000Z",
      }),
    ).toThrow(/immutable/);

    const page = store.readCurrentConversationPage("desktop", { cursor: null, limit: 10 });
    expect(page.schemaVersion).toBe(2);
    if (page.schemaVersion !== 2) throw new Error("Expected decision transcript page.");
    expect(page.entries.map((entry) => entry.kind)).toEqual([
      "decision-requested",
      "decision-answered",
      "decision-continuation-completed",
    ]);
    expect(page.entries.at(-1)).toMatchObject({
      turnId: "turn-2",
      coachText: "I kept tomorrow easy and protected the weekend.",
      completedAt: "2026-08-24T00:04:00.000Z",
    });

    const bounded = store.readCurrentConversationPage("desktop", { cursor: null, limit: 1 });
    expect(bounded.schemaVersion).toBe(2);
    if (bounded.schemaVersion !== 2) throw new Error("Expected decision transcript page.");
    expect(bounded.entries.map((entry) => entry.kind)).toEqual([
      "decision-requested",
      "decision-answered",
      "decision-continuation-completed",
    ]);
    expect(bounded.nextCursor).toBeNull();
  });

  it("abandons an unanswered decision before reset and exposes it in the archive", () => {
    const dataDir = makeDataDir();
    const store = new ConversationStore(
      new ChatStore(dataDir),
      new TranscriptStore(dataDir),
      () => RESET_ID,
    );
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: unanswered(),
      toolCallId: "tool-1",
      athleteText: "Should I keep tomorrow's tempo session?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });
    store.resetConversation({
      chatId: "desktop",
      boundaryAt: "2026-08-24T01:00:00.000Z",
      reason: "explicit-reset",
    });

    const page = store.readArchivedConversationPage("desktop", RESET_ID, {
      cursor: null,
      limit: 10,
    });
    expect(page.schemaVersion).toBe(2);
    if (page.schemaVersion !== 2) throw new Error("Expected decision transcript page.");
    expect(page.entries.map((entry) => entry.kind)).toEqual([
      "decision-requested",
      "decision-abandoned",
    ]);
    expect(store.listArchivedConversations("desktop").conversations).toMatchObject([
      { boundaryRef: RESET_ID, turnCount: 1 },
    ]);
    expect(store.getDecision("desktop")).toBeNull();
  });

  it("retains the reset intent when boundary append fails after abandonment", () => {
    const dataDir = makeDataDir();
    const transcript = new TranscriptStore(dataDir, {
      write(descriptor, buffer, offset, length, position) {
        const bytes = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).subarray(
          offset,
          offset + length,
        );
        if (bytes.includes(Buffer.from('"kind":"conversation-boundary"'))) {
          throw new Error("synthetic boundary failure");
        }
        return writeSync(descriptor, buffer, offset, length, position);
      },
    });
    const store = new ConversationStore(new ChatStore(dataDir), transcript, () => RESET_ID);
    store.appendDecisionRequested({
      turnId: "turn-decision",
      decision: unanswered(),
      toolCallId: "tool-1",
      athleteText: "Should I keep tomorrow's tempo session?",
      requestedAt: "2026-08-24T00:00:00.000Z",
    });

    expect(() =>
      store.resetConversation({
        chatId: "desktop",
        boundaryAt: "2026-08-24T01:00:00.000Z",
        reason: "explicit-reset",
      }),
    ).toThrow("synthetic boundary failure");
    expect(transcript.readResetIntent("desktop")).not.toBeNull();
    expect(transcript.getDecision("desktop")).toMatchObject({ status: "abandoned" });

    const recovered = new ConversationStore(new ChatStore(dataDir), new TranscriptStore(dataDir));
    expect(recovered.getDecision("desktop")).toBeNull();
    const page = recovered.readArchivedConversationPage("desktop", RESET_ID, {
      cursor: null,
      limit: 10,
    });
    expect(page.schemaVersion).toBe(2);
    if (page.schemaVersion !== 2) throw new Error("Expected decision transcript page.");
    expect(page.entries.map((entry) => entry.kind)).toEqual([
      "decision-requested",
      "decision-abandoned",
    ]);
  });
});
