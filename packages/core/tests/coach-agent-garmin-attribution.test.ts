import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tool, zodSchema } from "ai";
import { z } from "zod";
import type { Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import { GARMIN_DATA_ATTRIBUTION } from "../src/agent/garmin-attribution.js";

let tempHome: string;
let originalHome: string | undefined;
let dataDir: string;

const syntheticSport: Sport = {
  id: "cycling",
  soul: "# Synthetic Coach",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: [],
  mustPreserveTokens: [],
  intervalsActivityTypes: ["Ride"],
  athleteProfileSchema: z.object({}),
  tools: () => [],
};

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-garmin-attribution-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempHome;
  dataDir = join(tempHome, ".cycling-coach");
  mkdirSync(join(dataDir, "memory"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function assistant(text: string, stopReason: "stop" | "length" | "toolUse" = "stop") {
  return {
    text,
    toolCalls: [] as Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason,
  };
}

async function setupAgent(complete: ReturnType<typeof vi.fn>, sport: Sport = syntheticSport) {
  vi.doMock("../src/agent/codex/responses.js", () => ({ codexResponses: complete }));
  vi.doMock("../src/agent/codex/oauth.js", () => ({
    refreshCodexToken: vi.fn(),
    loginCodex: vi.fn(),
  }));
  vi.doMock("../src/auth/profiles.js", () => ({
    getFreshToken: vi.fn(async () => "synthetic-token"),
    loadProfile: vi.fn(),
    saveProfile: vi.fn(),
    RefreshTokenReusedError: class extends Error {},
  }));
  const { CoachAgent } = await import("../src/agent/coach-agent.js");
  return new CoachAgent(sport, baseAgentConfig(dataDir));
}

function exactLineCount(text: string): number {
  return text.split("\n").filter((line) => line === GARMIN_DATA_ATTRIBUTION).length;
}

function assistantHistory(chatId: string): string[] {
  const path = join(dataDir, "sessions", `${chatId}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { role: string; content: string })
    .filter((line) => line.role === "assistant")
    .map((line) => line.content);
}

describe("CoachAgent Garmin attribution", () => {
  it("persists and returns the same attributed assistant core", async () => {
    const agent = await setupAgent(vi.fn(async () => assistant("Easy spin today.")));

    const reply = await agent.chat("normal", "What should I do?");

    expect(reply).toBe(`Easy spin today.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(assistantHistory("normal")).toEqual([reply]);
    expect(exactLineCount(reply)).toBe(1);
  });

  it("attributes /status through the same successful reply path", async () => {
    const agent = await setupAgent(vi.fn(async () => assistant("Fitness is steady.")));

    const reply = await agent.chat("status", "/status");

    expect(reply).toBe(`Fitness is steady.\n\n${GARMIN_DATA_ATTRIBUTION}`);
  });

  it("attributes a wellness-tool turn without inspecting tool data", async () => {
    const wellnessExecute = vi.fn(async () => ({ sleepHours: 7.25, restingHeartRate: 48 }));
    const wellnessSport: Sport = {
      ...syntheticSport,
      tools: () => [
        {
          name: "intervals_fetch_wellness",
          description: "Read synthetic wellness data.",
          inputSchema: z.unknown(),
          tool: tool({
            description: "Read synthetic wellness data.",
            inputSchema: zodSchema(z.object({})),
            execute: wellnessExecute,
          }),
        },
      ],
    };
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return {
          ...assistant("", "toolUse"),
          toolCalls: [
            {
              id: "wellness-call|wellness-item",
              name: "intervals_fetch_wellness",
              arguments: {},
            },
          ],
        };
      }
      return assistant("Your recovery signals look stable.");
    });
    const agent = await setupAgent(complete, wellnessSport);

    const reply = await agent.chat("wellness", "How did I recover?");

    expect(wellnessExecute).toHaveBeenCalledOnce();
    expect(reply).toBe(`Your recovery signals look stable.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(exactLineCount(reply)).toBe(1);
  });

  it("attributes a later history-reuse turn with no current tool call", async () => {
    let turn = 0;
    const complete = vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => {
      turn++;
      if (turn === 2) expect(JSON.stringify(params.messages)).toContain(GARMIN_DATA_ATTRIBUTION);
      return assistant(turn === 1 ? "Fatigue has eased." : "Keep tomorrow aerobic.");
    });
    const agent = await setupAgent(complete);

    await agent.chat("history", "How is fatigue?");
    const later = await agent.chat("history", "What about tomorrow?");

    expect(later).toBe(`Keep tomorrow aerobic.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(assistantHistory("history")).toHaveLength(2);
  });

  it("deduplicates model copy after step-exhaustion recovery", async () => {
    const complete = vi.fn(async (params: { tools?: unknown }) => {
      if (params.tools !== undefined) return assistant("", "length");
      return assistant(
        `Recovered guidance.\n${GARMIN_DATA_ATTRIBUTION}\n${GARMIN_DATA_ATTRIBUTION}`,
      );
    });
    const agent = await setupAgent(complete);

    const reply = await agent.chat("recovery", "Review this deeply.");

    expect(reply).toBe(`Recovered guidance.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(assistantHistory("recovery")).toEqual([reply]);
  });

  it("attributes concurrent chats independently without shared attribution state", async () => {
    const complete = vi.fn(async (params: { messages: Array<{ role: string; content: unknown }> }) => {
      const serialized = JSON.stringify(params.messages);
      await Promise.resolve();
      return assistant(serialized.includes("first request") ? "First answer." : "Second answer.");
    });
    const agent = await setupAgent(complete);

    const [first, second] = await Promise.all([
      agent.chat("concurrent-a", "first request"),
      agent.chat("concurrent-b", "second request"),
    ]);

    expect(first).toBe(`First answer.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(second).toBe(`Second answer.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(exactLineCount(first)).toBe(1);
    expect(exactLineCount(second)).toBe(1);
  });
});
