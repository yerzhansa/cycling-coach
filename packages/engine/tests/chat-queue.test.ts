import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cyclingSport } from "@enduragent/sport-cycling";
import { createCoachEngine } from "../src/index.js";
import type { EngineHostPorts, ModelTransportRequest } from "../src/host-ports.js";
import type { GenerateResult, Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function generated(text: string): GenerateResult {
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  };
  return { text, toolCalls: [], finishReason: "stop", usage, totalUsage: usage, steps: 1 };
}

function setup(
  root = mkdtempSync(join(tmpdir(), "engine-chat-queue-")),
  generate: (request: ModelTransportRequest) => Promise<GenerateResult> = async () =>
    generated("Done"),
) {
  if (!roots.includes(root)) roots.push(root);
  const base = baseAgentConfig(root);
  let sequence = 0;
  const ports: EngineHostPorts = {
    ...base,
    transcriptWriter: base.chatStore as unknown as EngineHostPorts["transcriptWriter"],
    randomId: () => `id-${++sequence}`,
    modelTransportDecorator: () => ({ generate }),
  };
  return {
    root,
    ports,
    engine: createCoachEngine({ sport: cyclingSport as unknown as Sport, ports }),
  };
}

describe("engine durable chat queue", () => {
  it("assigns host-owned Message identities and preserves ordinary attachment references", async () => {
    const { engine } = setup();
    const queued = await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "submission-1",
      text: "Review this activity",
      attachmentIds: ["attachment-1"],
    });
    expect(queued.items[0]).toMatchObject({
      queuedMessageId: "id-1",
      messageId: "id-2",
      attachmentIds: ["attachment-1"],
    });
    await expect(
      engine.enqueueChatMessage!({
        chatId: "desktop",
        submissionId: "submission-2",
        text: "/review",
        attachmentIds: ["attachment-2"],
      }),
    ).rejects.toThrow(/text-only/u);
  });

  it("groups consecutive ordinary messages and stops at a command barrier", async () => {
    const requests: ModelTransportRequest[] = [];
    const { engine } = setup(undefined, async (request) => {
      requests.push(request);
      return generated(`Reply ${requests.length}`);
    });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s1", text: "First" });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s2", text: "Second" });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s3", text: "/review" });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s4", text: "Later" });

    const first = await engine.resumeChatQueue!({ chatId: "desktop" });
    expect(first.response?.text).toBe("Reply 1");
    expect(first.snapshot.items.map((item) => item.text)).toEqual(["/review", "Later"]);
    expect(JSON.stringify(requests[0]?.options.messages)).toContain("First\\n\\nSecond");

    const command = await engine.resumeChatQueue!({ chatId: "desktop" });
    expect(command.response?.text).toBe("Reply 2");
    expect(command.snapshot.items.map((item) => item.text)).toEqual(["Later"]);
  });

  it("requires Run command only after a slash command is restored", async () => {
    const first = setup();
    const queued = await first.engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "s1",
      text: "/review",
    });
    const id = queued.items[0]!.queuedMessageId;
    const restored = setup(first.root);

    const held = await restored.engine.resumeChatQueue!({ chatId: "desktop" });
    expect(held.response).toBeUndefined();
    expect(held.snapshot.items[0]).toMatchObject({ restored: true, queuedMessageId: id });
    await expect(
      restored.engine.runQueuedCommand!({ chatId: "desktop", queuedMessageId: id }),
    ).resolves.toMatchObject({ response: { text: "Done" }, snapshot: { items: [] } });
  });

  it("does not claim or run while an unanswered coach decision owns the chat", async () => {
    const generate = vi.fn(async () => generated("Unexpected"));
    const { engine, ports } = setup(undefined, generate);
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s1", text: "Later" });
    ports.coachDecisions!.appendDecisionRequested({
      turnId: "turn-decision",
      decision: {
        status: "unanswered",
        decisionId: "decision-1",
        chatId: "desktop",
        messageId: "message-1",
        question: "Choose.",
        options: [
          { id: "a", label: "A", description: "A", recommended: true, consequence: "A" },
          { id: "b", label: "B", description: "B", recommended: false, consequence: "B" },
        ],
      },
      toolCallId: "tool-1",
      athleteText: "Question",
      requestedAt: "2026-08-25T00:00:00.000Z",
    });

    const blocked = await engine.resumeChatQueue!({ chatId: "desktop" });
    expect(blocked.response).toBeUndefined();
    expect(blocked.snapshot.items.map((item) => item.text)).toEqual(["Later"]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("fences queue execution behind a paused reset for the same chat", async () => {
    let releaseFlush!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let allowFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      allowFlush = resolve;
    });
    const generate = vi.fn(async (request: ModelTransportRequest) => {
      if (request.options.caller === "flush") {
        releaseFlush();
        await flushGate;
        return generated("Flush complete");
      }
      return generated("Unexpected queue response");
    });
    const { engine, ports } = setup(undefined, generate);
    ports.chatStore.overwriteHistory("desktop", [{ role: "user", content: "Earlier message" }]);
    await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "submission-1",
      text: "Queued during reset race",
    });

    const reset = engine.resetSession({ chatId: "desktop" });
    await flushStarted;
    const resume = engine.resumeChatQueue!({ chatId: "desktop" });
    await Promise.resolve();
    expect(generate).toHaveBeenCalledTimes(1);
    allowFlush();

    await expect(reset).resolves.toMatchObject({ memoryFlushed: true });
    await expect(resume).resolves.toMatchObject({ snapshot: { items: [] } });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("reconciles a durably projected claimed turn without rerunning it", async () => {
    const generate = vi.fn(async () => generated("Unexpected"));
    const { engine, ports } = setup(undefined, generate);
    const queued = await engine.enqueueChatMessage!({
      chatId: "desktop",
      submissionId: "s1",
      text: "First",
    });
    const id = queued.items[0]!.queuedMessageId;
    ports.chatStore.claimChatQueue!("desktop", "claim-1", "turn-1", [id]);
    ports.transcriptWriter.appendCompletedTurn({
      chatId: "desktop",
      turnId: "turn-1",
      completedAt: "2026-08-25T00:00:00.000Z",
      athleteText: "First",
      coachText: "Done",
    });

    expect(await engine.getChatQueue!({ chatId: "desktop" })).toMatchObject({ items: [] });
    expect(generate).not.toHaveBeenCalled();
  });

  it("Stop marks only the active claim retry-required and never drains the command behind it", async () => {
    let started!: () => void;
    const active = new Promise<void>((resolve) => {
      started = resolve;
    });
    let attempts = 0;
    const generate = vi.fn((request: ModelTransportRequest) => {
      attempts += 1;
      if (attempts === 2) return Promise.resolve(generated("Recovered"));
      return new Promise<GenerateResult>((_resolve, reject) => {
        started();
        request.options.signal?.addEventListener("abort", () => reject(new Error("stopped")), {
          once: true,
        });
      });
    });
    const { engine } = setup(undefined, generate);
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s1", text: "First" });
    await engine.enqueueChatMessage!({ chatId: "desktop", submissionId: "s2", text: "/review" });
    let activeTurnId: string | undefined;
    const running = engine.resumeChatQueue!({ chatId: "desktop" }, (event) => {
      if (event.type === "turn-start") activeTurnId = event.turnId;
    }).catch(() => undefined);
    await active;
    if (activeTurnId === undefined) throw new Error("active turn was not announced");
    await engine.stopChat!({ chatId: "desktop", turnId: activeTurnId });
    await running;

    const snapshot = await engine.getChatQueue!({ chatId: "desktop" });
    expect(snapshot.retryRequired).toMatchObject({
      queuedMessageIds: [snapshot.items[0]!.queuedMessageId],
    });
    expect(snapshot.items.map((item) => item.text)).toEqual(["First", "/review"]);
    expect(generate).toHaveBeenCalledTimes(1);

    const retried = await engine.retryQueuedTurn!({
      chatId: "desktop",
      claimId: snapshot.retryRequired!.claimId,
    });
    expect(retried.response?.text).toBe("Recovered");
    expect(retried.snapshot.retryRequired).toBeUndefined();
    expect(retried.snapshot.items.map((item) => item.text)).toEqual(["/review"]);
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
