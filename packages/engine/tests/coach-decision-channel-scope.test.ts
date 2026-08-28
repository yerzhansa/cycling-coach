import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sport } from "../src/sport.js";
import { baseAgentConfig } from "./helpers/base-agent-config.js";

const dirs: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("coach decision channel scope", () => {
  it.each(["telegram:123", "cli"])(
    "returns numbered text without decision state for %s",
    async (chatId) => {
      const dataDir = mkdtempSync(join(tmpdir(), "decision-channel-scope-"));
      dirs.push(dataDir);
      const complete = vi.fn(async () => ({
        text: "",
        toolCalls: [
          {
            id: `tool-${chatId}`,
            name: "request_user_decision",
            arguments: {
              question: "Choose tomorrow's priority.",
              options: [
                {
                  label: "Recovery",
                  description: "Ride easy.",
                  recommended: true,
                  consequence: "Tomorrow becomes a recovery day.",
                },
                {
                  label: "Tempo",
                  description: "Keep the planned work.",
                  recommended: false,
                  consequence: "Tomorrow keeps the tempo session.",
                },
              ],
            },
          },
        ],
        usage: {
          input: 10,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 11,
        },
        stopReason: "toolUse",
      }));
      vi.doMock("../src/agent/codex/responses.js", () => ({ codexResponses: complete }));
      const { createCoachEngine } = await import("../src/index.js");
      const ports = baseAgentConfig(dataDir);
      const engine = createCoachEngine({
        sport: {
          id: "cycling",
          soul: "",
          skills: {},
          sessionClusterGapMinutes: 30,
          memorySections: [],
          mustPreserveTokens: [],
          intervalsActivityTypes: [],
          athleteProfileSchema: {} as never,
          tools: () => [],
        } as Sport,
        ports,
      });

      const response = await engine.chat({ chatId, message: "What should I do tomorrow?" });

      expect(response).toEqual({
        text:
          "Choose tomorrow's priority.\n" +
          "1. Recovery (Recommended) — Ride easy.\n" +
          "2. Tempo — Keep the planned work.\n" +
          "Reply with a number, write your own answer, or say skip.",
      });
      expect(ports.coachDecisions?.getDecision(chatId)).toBeNull();
      expect(complete).toHaveBeenCalledTimes(1);
    },
  );
});
