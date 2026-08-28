import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnEvent } from "@enduragent/coach-contract";
import { cyclingSport } from "@enduragent/sport-cycling";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoachAgent } from "../src/agent/coach-agent.js";
import type {
  EngineHostPorts,
  ModelTransport,
  ConversationResetInput,
  TranscriptCompletedTurnInput,
  TranscriptInterruptedTurnInput,
} from "../src/host-ports.js";
import type { GenerateResult } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const roots: string[] = [];

function makeDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "engine-transcript-"));
  roots.push(dataDir);
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  return dataDir;
}

function result(text: string): GenerateResult {
  const usage = {
    inputTokens: 2,
    outputTokens: 1,
    totalTokens: 3,
    inputTokenDetails: {
      noCacheTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  };
  return {
    text,
    toolCalls: [],
    finishReason: "stop",
    usage,
    totalUsage: usage,
    steps: 1,
  };
}

function harness(input: {
  generate: ModelTransport["generate"];
  classifyFailure?: EngineHostPorts["classifyFailure"];
  appendCompletedTurn?: (turn: TranscriptCompletedTurnInput) => void;
  appendInterruptedTurn?: (turn: TranscriptInterruptedTurnInput) => void;
  config?: Partial<EngineHostPorts["config"]["session"]>;
  randomId?: () => string;
}) {
  const dataDir = makeDataDir();
  const base = baseAgentConfig(dataDir);
  const completed: TranscriptCompletedTurnInput[] = [];
  const interrupted: TranscriptInterruptedTurnInput[] = [];
  const boundaries: ConversationResetInput[] = [];
  const warnings: Array<{ event: string; error: unknown; fields: unknown }> = [];
  vi.spyOn(base.chatStore, "resetConversation").mockImplementation((boundary) => {
    boundaries.push(boundary);
  });
  const ports: EngineHostPorts = {
    ...base,
    config: {
      ...base.config,
      session: { ...base.config.session, timezone: "UTC", ...input.config },
    },
    now: () => Date.parse("2026-07-22T12:34:56.789Z"),
    randomId: input.randomId ?? (() => "turn-transcript-1"),
    classifyFailure: input.classifyFailure ?? base.classifyFailure,
    logger: {
      ...base.logger,
      warn: (event, error, fields) => warnings.push({ event, error, fields }),
    },
    transcriptWriter: {
      appendCompletedTurn: input.appendCompletedTurn ?? ((turn) => completed.push(turn)),
      appendInterruptedTurn: input.appendInterruptedTurn ?? ((turn) => interrupted.push(turn)),
    },
    modelTransportDecorator: () => ({ generate: input.generate }),
  };
  return {
    dataDir,
    completed,
    interrupted,
    boundaries,
    warnings,
    agent: new CoachAgent(cyclingSport, ports),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CoachAgent transcript recording", () => {
  it("records one original-athlete/canonical-coach pair before final delivery", async () => {
    const trace: string[] = [];
    const completed: TranscriptCompletedTurnInput[] = [];
    const setup = harness({
      generate: async () => result("  canonical coach text 🚴  "),
      appendCompletedTurn: (turn) => {
        trace.push("transcript");
        completed.push(turn);
      },
    });
    const events: TurnEvent[] = [];

    const text = await setup.agent.chat(
      "chat-normal",
      "  original athlete text\n",
      undefined,
      (event) => {
        events.push(event);
        if (event.type === "final-text") trace.push("final");
      },
    );

    expect(text).toBe("  canonical coach text 🚴  ");
    expect(completed).toEqual([
      {
        chatId: "chat-normal",
        turnId: "turn-transcript-1",
        completedAt: "2026-07-22T12:34:56.789Z",
        athleteText: "  original athlete text\n",
        coachText: "  canonical coach text 🚴  ",
      },
    ]);
    expect(trace).toEqual(["transcript", "final"]);
    expect(events.filter((event) => event.type === "final-text")).toHaveLength(1);
  });

  it("records once across overflow compaction and retry", async () => {
    let chatAttempts = 0;
    const setup = harness({
      classifyFailure: () => "overflow",
      generate: async (request) => {
        if (request.options.caller === "flush") return result("flush complete");
        if (request.options.caller === "compact") return result("compact summary");
        chatAttempts += 1;
        if (chatAttempts === 1) throw new Error("synthetic overflow");
        return result("recovered response");
      },
    });

    await expect(setup.agent.chat("chat-retry", "athlete retry text")).resolves.toBe(
      "recovered response",
    );
    expect(chatAttempts).toBe(2);
    expect(setup.completed).toHaveLength(1);
    expect(setup.completed[0]).toMatchObject({
      athleteText: "athlete retry text",
      coachText: "recovered response",
    });
  });

  it.each(["ENOSPC", "EACCES"])(
    "keeps final delivery exact and single when the transcript writer throws %s",
    async (code) => {
      const append = vi.fn(() => {
        throw Object.assign(new Error("synthetic transcript failure"), { code });
      });
      const setup = harness({
        generate: async () => result("delivered exactly once"),
        appendCompletedTurn: append,
      });
      const events: TurnEvent[] = [];

      await expect(
        setup.agent.chat("chat-failure", "private athlete content", undefined, (event) =>
          events.push(event),
        ),
      ).resolves.toBe("delivered exactly once");

      expect(append).toHaveBeenCalledTimes(1);
      expect(events.filter((event) => event.type === "final-text")).toEqual([
        {
          type: "final-text",
          turnId: "turn-transcript-1",
          text: "delivered exactly once",
        },
      ]);
      expect(setup.warnings).toEqual([
        {
          event: "transcript_record_failed",
          error: undefined,
          fields: {
            operation: "turn-completed",
            reason: code === "ENOSPC" ? "storage-full" : "permission-denied",
          },
        },
      ]);
      expect(JSON.stringify(setup.warnings)).not.toContain("private athlete content");
      expect(JSON.stringify(setup.warnings)).not.toContain("delivered exactly once");
    },
  );

  it("delivers once and logs fixed metadata when transcript capture is too large", async () => {
    const append = vi.fn(() => {
      throw Object.assign(new Error("synthetic oversize transcript failure"), {
        code: "TRANSCRIPT_RECORD_TOO_LARGE",
      });
    });
    const setup = harness({
      generate: async () => result("synthetic exact coach response"),
      appendCompletedTurn: append,
    });
    const events: TurnEvent[] = [];

    await expect(
      setup.agent.chat("chat-oversize", "synthetic athlete input", undefined, (event) =>
        events.push(event),
      ),
    ).resolves.toBe("synthetic exact coach response");

    expect(append).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event.type === "final-text")).toEqual([
      {
        type: "final-text",
        turnId: "turn-transcript-1",
        text: "synthetic exact coach response",
      },
    ]);
    expect(setup.warnings).toEqual([
      {
        event: "transcript_record_failed",
        error: undefined,
        fields: {
          operation: "turn-completed",
          reason: "record-too-large",
        },
      },
    ]);
  });

  it("records no completed turn for an ordinary terminal failure", async () => {
    const failure = new Error("synthetic terminal failure");
    const setup = harness({
      classifyFailure: () => "invalid_request",
      generate: async () => {
        throw failure;
      },
    });
    const events: TurnEvent[] = [];

    await expect(
      setup.agent.chat("chat-terminal", "not delivered", undefined, (event) => events.push(event)),
    ).rejects.toBe(failure);
    expect(setup.completed).toEqual([]);
    expect(events.some((event) => event.type === "final-text")).toBe(false);
  });

  it("stops only the active response, records its partial text, and accepts the next turn", async () => {
    let releaseFirst: (() => void) | undefined;
    let attempt = 0;
    const setup = harness({
      generate: async (request) => {
        attempt += 1;
        if (attempt > 1) return result("next response");
        request.options.onTextDelta?.("Partial response");
        await new Promise<void>((resolve, reject) => {
          releaseFirst = resolve;
          request.options.signal?.addEventListener(
            "abort",
            () => reject(request.options.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        });
        return result("unreachable");
      },
    });
    const events: TurnEvent[] = [];
    const first = setup.agent.chat("chat-stop", "stop this", undefined, (event) =>
      events.push(event),
    );

    await vi.waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    expect(setup.agent.stopChat("chat-stop", "turn-transcript-1")).toBe(true);
    await expect(first).resolves.toBe("Partial response");
    expect(setup.agent.stopChat("chat-stop", "turn-transcript-1")).toBe(false);
    expect(setup.completed).toEqual([]);
    expect(setup.interrupted).toEqual([
      {
        chatId: "chat-stop",
        turnId: "turn-transcript-1",
        completedAt: "2026-07-22T12:34:56.789Z",
        athleteText: "stop this",
        coachText: "Partial response",
      },
    ]);
    expect(events.at(0)).toEqual({
      type: "turn-start",
      turnId: "turn-transcript-1",
      chatId: "chat-stop",
    });
    expect(events.at(-1)).toEqual({
      type: "interrupted",
      turnId: "turn-transcript-1",
      chatId: "chat-stop",
      text: "Partial response",
    });

    await expect(setup.agent.chat("chat-stop", "continue")).resolves.toBe("next response");
    releaseFirst?.();
  });

  it("ignores a delayed Stop for a completed turn after its successor starts", async () => {
    const ids = ["turn-a", "turn-b"];
    let secondStarted!: () => void;
    const activeSecond = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let secondSignal: AbortSignal | undefined;
    let attempt = 0;
    const setup = harness({
      randomId: () => ids.shift() ?? "unexpected-turn",
      generate: async (request) => {
        attempt += 1;
        if (attempt === 1) return result("First response");
        secondSignal = request.options.signal;
        secondStarted();
        await new Promise<void>((_resolve, reject) => {
          request.options.signal?.addEventListener("abort", () => reject(new Error("stopped")), {
            once: true,
          });
        });
        return result("unreachable");
      },
    });

    await setup.agent.chat("chat-stop-scope", "first");
    const second = setup.agent.chat("chat-stop-scope", "second");
    await activeSecond;
    expect(setup.agent.stopChat("chat-stop-scope", "turn-a")).toBe(false);
    expect(secondSignal?.aborted).toBe(false);
    expect(setup.agent.stopChat("chat-stop-scope", "turn-b")).toBe(true);
    await expect(second).resolves.toBe("");
  });

  it.each([
    {
      name: "daily",
      lastMessageTime: "2026-06-11T03:00:00.000Z",
      session: { dailyResetHour: 4, idleMinutes: 0 },
    },
    {
      name: "idle",
      lastMessageTime: "2026-06-11T11:29:00.000Z",
      session: { dailyResetHour: 0, idleMinutes: 30 },
    },
  ])("appends a stale boundary after a successful $name reset", async (fixture) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T12:00:00.000Z"));
    const setup = harness({
      config: fixture.session,
      generate: async (request) =>
        request.options.caller === "flush" ? result("flush complete") : result("new response"),
    });
    writeFileSync(
      join(setup.dataDir, "sessions", "stale-chat.jsonl"),
      [
        { role: "user", content: "old athlete", ts: fixture.lastMessageTime },
        { role: "assistant", content: "old coach", ts: fixture.lastMessageTime },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
      { mode: 0o600 },
    );

    // An automatic archive prefixes the one-time post-reset notice on the reply.
    const reply = await setup.agent.chat("stale-chat", "new athlete");
    expect(reply.startsWith("Started a fresh session")).toBe(true);
    expect(reply).toContain("new response");
    expect(setup.boundaries).toEqual([
      {
        chatId: "stale-chat",
        boundaryAt: "2026-07-22T12:34:56.789Z",
        reason: "stale-reset",
      },
    ]);
    expect(setup.completed).toHaveLength(1);
  });
});
