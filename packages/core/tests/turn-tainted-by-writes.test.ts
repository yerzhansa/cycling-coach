import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { http, HttpResponse } from "msw";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { createMockIntervalsServer } from "./helpers/mock-intervals.js";
import { cyclingSport } from "@enduragent/sport-cycling";
import type { Sport } from "../src/sport.js";
import { TAINTED_BY_WRITES_MESSAGE } from "../src/agent/coach-agent-copy.js";
import { COACH_EVENT_TAG } from "../src/agent/event-provenance.js";
import { appendGarminAttribution } from "../src/agent/garmin-attribution.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-taint-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mkAssistant(opts: {
  text?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  stopReason?: "stop" | "toolUse";
}) {
  return {
    text: opts.toolCall ? "" : opts.text ?? "",
    toolCalls: opts.toolCall
      ? [{ id: opts.toolCall.id, name: opts.toolCall.name, arguments: opts.toolCall.arguments }]
      : [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
    },
    stopReason: opts.stopReason ?? "stop",
  };
}

function intervalsConfig() {
  return {
    ...baseAgentConfig(dataDir),
    intervals: { apiKey: "test-key", athleteId: "i1" },
  };
}

async function setupAgent(complete: ReturnType<typeof vi.fn>) {
  vi.doMock("../src/agent/codex/responses.js", () => ({
    codexResponses: complete,
  }));
  vi.doMock("../src/agent/codex/oauth.js", () => ({
    refreshCodexToken: vi.fn(),
    loginCodex: vi.fn(),
  }));
  vi.doMock("../src/auth/profiles.js", () => ({
    getFreshToken: vi.fn(async () => "token"),
    loadProfile: vi.fn(),
    saveProfile: vi.fn(),
    RefreshTokenReusedError: class extends Error {},
  }));

  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  return new CoachAgent(cyclingSport as unknown as Sport, intervalsConfig());
}

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";

function tomorrowISODate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function dailyMemoryText(): string {
  const memoryDir = join(dataDir, "memory");
  return readdirSync(memoryDir)
    .filter((name) => name.endsWith(".md") && name !== "MEMORY.md")
    .map((name) => readFileSync(join(memoryDir, name), "utf-8"))
    .join("\n");
}

describe("tainted-by-writes refusal", () => {
  it("a create proposal then a brownout retries normally without writing", async () => {
    const { server, createdWorkouts } = createMockIntervalsServer();
    server.listen({ onUnhandledRequest: "bypass" });
    try {
      let mainTurns = 0;
      let secondMainAfterWrite = false;
      const complete = vi.fn(async (params: { system?: string }) => {
        const sys = params.system ?? "";
        if (sys.includes(FLUSH_MARKER)) return mkAssistant({ text: "facts noted" });
        if (sys.length === 0) return mkAssistant({ text: "summary" });
        mainTurns++;
        const ctx = params as { messages?: { role: string }[] };
        const hasToolResult = (ctx.messages ?? []).some((m) => m.role === "tool");
        if (mainTurns === 1 && !hasToolResult) {
          return mkAssistant({
            toolCall: {
              id: "call-1",
              name: "intervals_create_workout",
              arguments: {
                date: tomorrowISODate(),
                workout: {
                  name: "Threshold 2x20",
                  steps: [
                    { type: "warmup", duration: { value: 10, unit: "minutes" }, power: { kind: "percent_ftp", value: 50 } },
                    { type: "steady", duration: { value: 20, unit: "minutes" }, power: { kind: "percent_ftp", value: 95 } },
                  ],
                },
              },
            },
            stopReason: "toolUse",
          });
        }
        if (mainTurns >= 3) return mkAssistant({ text: "recovered after proposal" });
        secondMainAfterWrite = true;
        throw new Error("You have hit your rate limit. Try again later.");
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers();
      const agent = await setupAgent(complete);

      const chat = agent.chat("taint", "create a threshold workout for tomorrow");
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await chat;
      vi.useRealTimers();

      expect(result).toBe(appendGarminAttribution("recovered after proposal"));
      expect(result).not.toBe(TAINTED_BY_WRITES_MESSAGE);
      expect(createdWorkouts.length).toBe(0);
      expect(secondMainAfterWrite).toBe(true);
    } finally {
      server.close();
    }
  });

  it("a create proposal then a timeout retries normally without writing", async () => {
    const { server, createdWorkouts } = createMockIntervalsServer();
    server.listen({ onUnhandledRequest: "bypass" });
    try {
      let mainTurns = 0;
      let secondMainAfterWrite = false;
      const complete = vi.fn(async (params: { system?: string }) => {
        const sys = params.system ?? "";
        if (sys.includes(FLUSH_MARKER)) return mkAssistant({ text: "facts noted" });
        if (sys.length === 0) return mkAssistant({ text: "summary" });
        mainTurns++;
        const ctx = params as { messages?: { role: string }[] };
        const hasToolResult = (ctx.messages ?? []).some((m) => m.role === "tool");
        if (mainTurns === 1 && !hasToolResult) {
          return mkAssistant({
            toolCall: {
              id: "call-timeout",
              name: "intervals_create_workout",
              arguments: {
                date: tomorrowISODate(),
                workout: {
                  name: "Endurance 45",
                  steps: [
                    { type: "warmup", duration: { value: 10, unit: "minutes" }, power: { kind: "percent_ftp", value: 50 } },
                    { type: "steady", duration: { value: 35, unit: "minutes" }, power: { kind: "percent_ftp", value: 70 } },
                  ],
                },
              },
            },
            stopReason: "toolUse",
          });
        }
        if (mainTurns >= 3) return mkAssistant({ text: "recovered after proposal" });
        secondMainAfterWrite = true;
        const err = new Error("deadline exceeded");
        err.name = "TimeoutError";
        throw err;
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const agent = await setupAgent(complete);

      const result = await agent.chat("taint-timeout", "create an endurance workout for tomorrow");

      expect(result).toBe(appendGarminAttribution("recovered after proposal"));
      expect(result).not.toBe(TAINTED_BY_WRITES_MESSAGE);
      expect(createdWorkouts.length).toBe(0);
      expect(secondMainAfterWrite).toBe(true);
      expect(mainTurns).toBe(3);
    } finally {
      server.close();
    }
  });

  it("a memory write then timeout refuses without replaying the memory append", async () => {
    let mainTurns = 0;
    const note = "felt unusually fresh after breakfast";
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant({ text: "facts noted" });
      if (sys.length === 0) return mkAssistant({ text: "summary" });
      mainTurns++;
      const ctx = params as { messages?: { role: string }[] };
      const hasToolResult = (ctx.messages ?? []).some((m) => m.role === "tool");
      if (mainTurns === 1 && !hasToolResult) {
        return mkAssistant({
          toolCall: {
            id: "call-memory",
            name: "memory_write",
            arguments: { type: "daily", content: note },
          },
          stopReason: "toolUse",
        });
      }
      const err = new Error("deadline exceeded");
      err.name = "TimeoutError";
      throw err;
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);

    const result = await agent.chat("taint-memory", "remember that breakfast helped");

    expect(result).toBe(TAINTED_BY_WRITES_MESSAGE);
    expect(mainTurns).toBe(2);
    expect((dailyMemoryText().match(new RegExp(note, "g")) ?? []).length).toBe(1);
  });

  it("a plan-skeleton build then a timeout retries normally without saving a plan", async () => {
    let mainTurns = 0;
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant({ text: "facts noted" });
      if (sys.length === 0) return mkAssistant({ text: "summary" });
      mainTurns++;
      const ctx = params as { messages?: { role: string }[] };
      const hasToolResult = (ctx.messages ?? []).some((m) => m.role === "tool");
      if (mainTurns === 1 && !hasToolResult) {
        return mkAssistant({
          toolCall: {
            id: "call-plan",
            name: "build_plan_skeleton",
            arguments: {
              experienceLevel: "intermediate",
              ftpWatts: 250,
              volumeTier: "medium",
              scheduleType: "flexible",
              goalType: "general",
              generalGoal: "build aerobic base",
            },
          },
          stopReason: "toolUse",
        });
      }
      if (mainTurns === 2) {
        const err = new Error("deadline exceeded");
        err.name = "TimeoutError";
        throw err;
      }
      return mkAssistant({ text: "recovered after retry" });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);

    const result = await agent.chat("taint-plan", "build me a training plan");

    expect(result).toBe(appendGarminAttribution("recovered after retry"));
    expect(result).not.toBe(TAINTED_BY_WRITES_MESSAGE);
    expect(mainTurns).toBe(3);
    const journal = join(dataDir, "memory", "MEMORY.history.jsonl");
    const planSaves = (existsSync(journal) ? readFileSync(journal, "utf-8") : "")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as { op?: string })
      .filter((entry) => entry.op === "save-plan");
    expect(planSaves.length).toBe(0);
  });

  it("keeps write taint scoped when different chats run concurrently", async () => {
    const note = "freshness note scoped to the first chat";
    let firstMainCalls = 0;
    let secondMainCalls = 0;
    let releaseFirstAfterWrite = () => {};
    const firstAfterWrite = new Promise<void>((resolve) => {
      releaseFirstAfterWrite = resolve;
    });
    let markFirstPostWrite = () => {};
    const firstPostWrite = new Promise<void>((resolve) => {
      markFirstPostWrite = resolve;
    });
    const complete = vi.fn(async (params: { system?: string; messages?: { role: string; content?: unknown }[] }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant({ text: "facts noted" });
      if (sys.length === 0) return mkAssistant({ text: "summary" });

      const messages = params.messages ?? [];
      const transcript = JSON.stringify(messages);
      const hasToolResult = messages.some((m) => m.role === "tool");
      if (transcript.includes("first memory note")) {
        firstMainCalls++;
        if (!hasToolResult) {
          return mkAssistant({
            toolCall: {
              id: "call-concurrent-memory",
              name: "memory_write",
              arguments: { type: "daily", content: note },
            },
            stopReason: "toolUse",
          });
        }
        markFirstPostWrite();
        await firstAfterWrite;
        const err = new Error("deadline exceeded");
        err.name = "TimeoutError";
        throw err;
      }

      if (transcript.includes("second normal turn")) {
        secondMainCalls++;
        return mkAssistant({ text: "second ok" });
      }

      throw new Error(`unexpected messages: ${transcript}`);
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = await setupAgent(complete);

    const firstResultPromise = agent.chat("taint-concurrent-a", "first memory note");
    await firstPostWrite;
    const secondResult = await agent.chat("taint-concurrent-b", "second normal turn");
    releaseFirstAfterWrite();
    const firstResult = await firstResultPromise;

    expect(secondResult).toBe(appendGarminAttribution("second ok"));
    expect(firstResult).toBe(TAINTED_BY_WRITES_MESSAGE);
    expect(firstMainCalls).toBe(2);
    expect(secondMainCalls).toBe(1);
    expect((dailyMemoryText().match(new RegExp(note, "g")) ?? []).length).toBe(1);
  });

  it("a delete proposal on a turn that then errors does not taint or delete", async () => {
    const { server, createdWorkouts, deletedEventIds } = createMockIntervalsServer();
    // Seed an upcoming workout so the delete tool's get-before-delete succeeds.
    createdWorkouts.push({
      id: 7777,
      start_date_local: `${tomorrowISODate()}T00:00:00`,
      category: "WORKOUT",
      name: "To delete",
      type: "Ride",
      moving_time: 3600,
      tags: [COACH_EVENT_TAG],
    });
    server.listen({ onUnhandledRequest: "bypass" });
    try {
      let mainTurns = 0;
      const complete = vi.fn(async (params: { system?: string }) => {
        const sys = params.system ?? "";
        if (sys.includes(FLUSH_MARKER)) return mkAssistant({ text: "facts noted" });
        if (sys.length === 0) return mkAssistant({ text: "summary" });
        mainTurns++;
        const ctx = params as { messages?: { role: string }[] };
        const hasToolResult = (ctx.messages ?? []).some((m) => m.role === "tool");
        if (mainTurns === 1 && !hasToolResult) {
          return mkAssistant({
            toolCall: { id: "call-d", name: "intervals_delete_workout", arguments: { eventId: 7777 } },
            stopReason: "toolUse",
          });
        }
        if (mainTurns >= 3) return mkAssistant({ text: "recovered after delete proposal" });
        throw new Error("You have hit your rate limit. Try again later.");
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers();
      const agent = await setupAgent(complete);

      const chat = agent.chat("taint-del", "delete tomorrow's workout");
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await chat;
      vi.useRealTimers();

      expect(result).toBe(appendGarminAttribution("recovered after delete proposal"));
      expect(result).not.toBe(TAINTED_BY_WRITES_MESSAGE);
      expect(deletedEventIds).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("a no-write brownout still retries normally and the guard does not over-fire", async () => {
    let mainTurns = 0;
    const complete = vi.fn(async (params: { system?: string }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant({ text: "facts noted" });
      if (sys.length === 0) return mkAssistant({ text: "summary" });
      mainTurns++;
      if (mainTurns === 1) throw new Error("You have hit your rate limit. Try again later.");
      return mkAssistant({ text: "recovered after retry" });
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers();
    const agent = await setupAgent(complete);

    const chatPromise = agent.chat("nowrite", "hello");
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await chatPromise;
    vi.useRealTimers();

    expect(result).toBe(appendGarminAttribution("recovered after retry"));
    expect(result).not.toBe(TAINTED_BY_WRITES_MESSAGE);
    expect(mainTurns).toBe(2);
  });

  it("an errored (uncommitted) write does not taint and the loop still retries", async () => {
    const { server, createdWorkouts } = createMockIntervalsServer();
    // The POST fails server-side, so the create tool returns { error: ... }
    // rather than { created: true } — no committed write, no taint.
    server.use(
      http.post("https://intervals.icu/api/v1/athlete/:id/events", () =>
        HttpResponse.json({ error: "server_error" }, { status: 500 }),
      ),
    );
    server.listen({ onUnhandledRequest: "bypass" });
    try {
      let mainTurns = 0;
      const complete = vi.fn(async (params: { system?: string }) => {
        const sys = params.system ?? "";
        if (sys.includes(FLUSH_MARKER)) return mkAssistant({ text: "facts noted" });
        if (sys.length === 0) return mkAssistant({ text: "summary" });
        mainTurns++;
        const ctx = params as { messages?: { role: string }[] };
        const hasToolResult = (ctx.messages ?? []).some((m) => m.role === "tool");
        if (mainTurns === 1 && !hasToolResult) {
          return mkAssistant({
            toolCall: {
              id: "call-bad",
              name: "intervals_create_workout",
              arguments: {
                date: tomorrowISODate(),
                workout: {
                  name: "Threshold",
                  steps: [
                    { type: "steady", duration: { value: 20, unit: "minutes" }, power: { kind: "percent_ftp", value: 90 } },
                  ],
                },
              },
            },
            stopReason: "toolUse",
          });
        }
        if (mainTurns === 1) throw new Error("You have hit your rate limit. Try again later.");
        return mkAssistant({ text: "recovered, nothing saved" });
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.useFakeTimers();
      const agent = await setupAgent(complete);

      const chatPromise = agent.chat("errwrite", "create a workout");
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await chatPromise;
      vi.useRealTimers();

      expect(result).not.toBe(TAINTED_BY_WRITES_MESSAGE);
      expect(result).toBe(appendGarminAttribution("recovered, nothing saved"));
      expect(createdWorkouts.length).toBe(0);
    } finally {
      server.close();
    }
  });
});
