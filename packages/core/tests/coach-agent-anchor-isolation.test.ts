import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { tool } from "ai";
import { baseAgentConfig } from "./helpers/base-agent-config.js";
import type {
  CoreDeps,
  MemorySectionSpec,
  Sport,
  ToolRegistration,
} from "../src/index.js";
import type { ResolvedCs } from "../src/reference/cs-resolution.js";

let tempHome: string;
let origHome: string | undefined;
let dataDir: string;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-anchor-iso-"));
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

const sections: readonly MemorySectionSpec[] = [
  { name: "running-profile", description: "VDOT, easy pace, recent race times" },
];

// A barrier that lets the test interleave the two in-flight turns: the first
// tool to read its anchor parks on `gate`; the second tool reads ITS anchor and
// then releases the gate. With AsyncLocalStorage each tool sees its own anchor;
// with a shared instance field the second chat()'s value would have overwritten
// the first's before the first tool reads — which is exactly what this catches.
function makeBarrier(): {
  arrive: () => Promise<void>;
  reset: () => void;
} {
  let waiting: (() => void) | null = null;
  return {
    arrive() {
      return new Promise<void>((resolve) => {
        if (waiting) {
          const other = waiting;
          waiting = null;
          other();
          resolve();
        } else {
          waiting = resolve;
        }
      });
    },
    reset() {
      waiting = null;
    },
  };
}

const barrier = makeBarrier();
const readAnchors: Record<string, ResolvedCs | null> = {};

function makeStubRunningSport(): Sport {
  return {
    id: "running",
    soul: "",
    skills: {},
    sessionClusterGapMinutes: 60,
    memorySections: sections,
    mustPreserveTokens: () => ["VDOT"],
    intervalsActivityTypes: ["Run", "TrailRun"],
    athleteProfileSchema: z.object({}),
    tools: (deps: CoreDeps): readonly ToolRegistration[] => {
      const inputSchema = z.object({ label: z.string() });
      return [
        {
          name: "read_anchor",
          description: "Reads the per-turn resolved CS anchor.",
          inputSchema,
          tool: tool({
            description: "Reads the per-turn resolved CS anchor.",
            inputSchema,
            execute: async ({ label }: { label: string }) => {
              // Read THIS turn's anchor first, then sync at the barrier so both
              // turns are in flight when each reads — a shared field would be
              // clobbered by the later turn before the earlier reads.
              const anchor = deps.resolvedCs?.() ?? null;
              await barrier.arrive();
              readAnchors[label] = anchor;
              return JSON.stringify(anchor);
            },
          }),
        },
      ];
    },
  };
}

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
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: opts.stopReason ?? "stop",
  };
}

const FLUSH_MARKER = "reviewing a conversation to extract and save important athlete";

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
  return new CoachAgent(makeStubRunningSport(), baseAgentConfig(dataDir));
}

describe("per-turn anchor isolation (AsyncLocalStorage, not a shared field)", () => {
  it("two interleaved turns each read their OWN resolvedCs through the tool", async () => {
    barrier.reset();
    delete readAnchors.A;
    delete readAnchors.B;

    // The model emits the read_anchor tool call on step 1 (per turn), then text
    // on step 2. The tool argument carries the turn label so the test can map a
    // read back to the turn that issued it.
    const complete = vi.fn(async (params: { system?: string; messages?: { role: string }[] }) => {
      const sys = params.system ?? "";
      if (sys.includes(FLUSH_MARKER)) return mkAssistant({ text: "facts noted" });
      if (sys.length === 0) return mkAssistant({ text: "summary" });
      const hasToolResult = (params.messages ?? []).some((m) => m.role === "tool");
      if (hasToolResult) return mkAssistant({ text: "done" });
      // Recover the turn label from the latest user message.
      const lastUser = [...(params.messages ?? [])].reverse().find((m) => m.role === "user");
      const content = (lastUser as { content?: unknown } | undefined)?.content;
      const label = typeof content === "string" && content.startsWith("B") ? "B" : "A";
      return mkAssistant({
        toolCall: { id: `call-${label}`, name: "read_anchor", arguments: { label } },
        stopReason: "toolUse",
      });
    });

    const agent = await setupAgent(complete);

    const anchorA: ResolvedCs = { criticalSpeedMps: 4.0, source: "platform", confidence: "high" };
    const anchorB: ResolvedCs = { criticalSpeedMps: 5.0, source: "platform", confidence: "high" };

    // Distinct chat ids so the per-chat session lock does not serialize them —
    // both turns are genuinely in flight together.
    const [resA, resB] = await Promise.all([
      agent.chat("chat-A", "A: how's my pace?", { resolvedCs: anchorA }),
      agent.chat("chat-B", "B: how's my pace?", { resolvedCs: anchorB }),
    ]);

    expect(resA).toBe("done");
    expect(resB).toBe("done");

    // Each turn's tool read ITS OWN anchor. If resolvedCs were a shared instance
    // field, the second chat() would have overwritten it before the first tool
    // read, so both labels would show 5.0 (or both whichever wrote last).
    expect(readAnchors.A?.criticalSpeedMps).toBe(4.0);
    expect(readAnchors.B?.criticalSpeedMps).toBe(5.0);
  });
});
