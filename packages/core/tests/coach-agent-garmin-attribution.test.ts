import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function activitySport(execute: (input: Record<string, unknown>) => Promise<unknown>): Sport {
  return {
    ...syntheticSport,
    tools: () => [
      {
        name: "intervals_fetch_activities",
        description: "Read activities.",
        inputSchema: z.unknown(),
        tool: tool({
          description: "Read activities.",
          inputSchema: zodSchema(z.object({ label: z.string().optional() })),
          execute,
        }),
      },
    ],
  };
}

async function setupAgent(
  complete: ReturnType<typeof vi.fn>,
  sport: Sport = syntheticSport,
  contextWindowTokens?: number,
) {
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
  const config = baseAgentConfig(dataDir);
  return new CoachAgent(
    sport,
    contextWindowTokens === undefined ? config : { ...config, contextWindowTokens },
  );
}

let nextToolCallId = 1;

function toolCall(args: Record<string, unknown> = {}) {
  return {
    ...assistant("", "toolUse"),
    toolCalls: [
      { id: `call-${nextToolCallId++}|item`, name: "intervals_fetch_activities", arguments: args },
    ],
  };
}

function assistantHistory(chatId: string): Array<Record<string, unknown>> {
  const path = join(dataDir, "sessions", `${chatId}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.role === "assistant");
}

describe("CoachAgent selective Garmin attribution", () => {
  it.each([
    ["confirmed Garmin", "GARMIN_CONNECT", true],
    ["confirmed non-Garmin", "POLAR", false],
    ["unknown", "UPLOAD", false],
  ])("uses usable %s activity data", async (_name, source, attributed) => {
    let calls = 0;
    const execute = vi.fn(async () => [{ id: "synthetic", source, load: 42 }]);
    const complete = vi.fn(async () => (++calls === 1 ? toolCall() : assistant("Guidance.")));
    const agent = await setupAgent(complete, activitySport(execute));

    const reply = await agent.chat(String(source), "Coach me.");

    expect(execute).toHaveBeenCalledOnce();
    expect(reply).toBe(attributed ? `Guidance.\n\n${GARMIN_DATA_ATTRIBUTION}` : "Guidance.");
  });

  it("does not attribute a turn with no training data", async () => {
    const agent = await setupAgent(vi.fn(async () => assistant("General guidance.")));
    expect(await agent.chat("empty", "Hello")).toBe("General guidance.");
  });

  it("strips a model-supplied footer on an unknown turn", async () => {
    const agent = await setupAgent(
      vi.fn(async () => assistant(`General guidance.\n${GARMIN_DATA_ATTRIBUTION}`)),
    );
    expect(await agent.chat("strip", "Hello")).toBe("General guidance.");
  });

  it("observes a memoized Garmin result on every delivery", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls <= 2) return toolCall({ label: "same" });
      return assistant("Memoized guidance.");
    });
    const agent = await setupAgent(complete, activitySport(execute));

    const reply = await agent.chat("memo", "Use the activity twice.");

    expect(execute).toHaveBeenCalledOnce();
    expect(reply).toBe(`Memoized guidance.\n\n${GARMIN_DATA_ATTRIBUTION}`);
  });

  it("does not count source fields hidden by the result cap", async () => {
    const execute = vi.fn(async () => [
      { id: "synthetic", source: "GARMIN_CONNECT", samples: "x".repeat(20_000) },
    ]);
    let calls = 0;
    const complete = vi.fn(async () =>
      ++calls === 1 ? toolCall() : assistant("Capped guidance."),
    );
    const agent = await setupAgent(complete, activitySport(execute), 2_000);

    expect(await agent.chat("capped", "Use the activity.")).toBe("Capped guidance.");
  });

  it("does not carry Garmin evidence from a failed outer attempt", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1) return toolCall();
      if (calls === 2) {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      }
      return assistant("Retried guidance.");
    });
    const agent = await setupAgent(complete, activitySport(execute));

    expect(await agent.chat("retry", "Coach me.")).toBe("Retried guidance.");
  });

  it("does not carry hidden tool evidence into no-tools recovery", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1) return toolCall();
      if (calls === 2) return assistant("", "toolUse");
      return assistant("Recovered guidance.");
    });
    const agent = await setupAgent(complete, activitySport(execute));

    expect(await agent.chat("recovery", "Coach me.")).toBe("Recovered guidance.");
  });

  it("persists assistant provenance and reuses it only while history survives", async () => {
    const execute = vi.fn(async () => [{ id: "synthetic", source: "GARMIN_CONNECT" }]);
    let calls = 0;
    const complete = vi.fn(async () => {
      calls++;
      if (calls === 1) return toolCall();
      return assistant(calls === 2 ? "First." : "Second.");
    });
    const agent = await setupAgent(complete, activitySport(execute));

    await agent.chat("history", "First turn.");
    const later = await agent.chat("history", "Later turn.");

    expect(later).toBe(`Second.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(assistantHistory("history")[0].provenance).toEqual({
      garmin: true,
      nonGarmin: false,
      unknown: true,
    });
  });

  it("does not attribute history dropped before the generation boundary", async () => {
    const complete = vi.fn(async (params: { messages: unknown }) => {
      if (JSON.stringify(params.messages).includes("Incorporate these older conversation")) {
        throw new Error("summary unavailable");
      }
      return assistant("Visible-history guidance.");
    });
    const agent = await setupAgent(complete, syntheticSport, 8_000);
    const sessions = join(dataDir, "sessions");
    mkdirSync(sessions, { recursive: true });
    const ts = new Date().toISOString();
    writeFileSync(
      join(sessions, "dropped-history.jsonl"),
      [
        JSON.stringify({
          role: "assistant",
          content: "x".repeat(30_000),
          ts,
          provenance: { garmin: true, nonGarmin: false, unknown: false },
        }),
        JSON.stringify({ role: "assistant", content: "Visible unknown reply", ts }),
      ].join("\n") + "\n",
    );

    expect(await agent.chat("dropped-history", "What now?")).toBe("Visible-history guidance.");
  });

  it("isolates concurrent chats", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => [
      { id: input.label, source: input.label === "garmin" ? "GARMIN_CONNECT" : "POLAR" },
    ]);
    const seen = new Set<string>();
    const complete = vi.fn(
      async (params: { messages: Array<{ role: string; content: unknown }> }) => {
        const serialized = JSON.stringify(params.messages);
        const label = serialized.includes("garmin request") ? "garmin" : "polar";
        await Promise.resolve();
        if (!seen.has(label)) {
          seen.add(label);
          return toolCall({ label });
        }
        return assistant(`${label} answer.`);
      },
    );
    const agent = await setupAgent(complete, activitySport(execute));

    const [garmin, polar] = await Promise.all([
      agent.chat("concurrent-g", "garmin request"),
      agent.chat("concurrent-p", "polar request"),
    ]);

    expect(garmin).toBe(`garmin answer.\n\n${GARMIN_DATA_ATTRIBUTION}`);
    expect(polar).toBe("polar answer.");
  });
});
