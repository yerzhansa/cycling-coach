import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  query as sdkQuery,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCliRuntime } from "../../src/agent/claude-cli/env.js";
import {
  CLAUDE_CLI_VERSION_FLOOR,
  compareVersions,
  probeVersion,
  resolveClaudeBinary,
} from "../../src/agent/claude-cli/executable.js";
import { buildQueryOptions, startGeneration } from "../../src/agent/claude-cli/session.js";

const ENABLED = process.env.CLAUDE_CLI_E2E !== undefined && process.env.CLAUDE_CLI_E2E !== "";
const MODEL = "haiku";
const DEADLINE_MS = 120_000;

async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function resolveRuntime(): Promise<ClaudeCliRuntime> {
  const explicitPath =
    process.env.CLAUDE_CLI_E2E_BINARY ?? join(homedir(), ".local", "bin", "claude");
  const binaryPath = await resolveClaudeBinary({ explicitPath });
  if (binaryPath === null) throw new Error("no Claude Code CLI resolved for the gated e2e run");
  return { binaryPath, billing: "subscription" };
}

function neverEndingPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<SDKUserMessage>> => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { done: true, value: undefined };
      },
    }),
  };
}

async function collect(iterable: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const seen: SDKMessage[] = [];
  for await (const message of iterable) seen.push(message);
  return seen;
}

function sessionIdOf(frames: SDKMessage[]): string {
  for (const frame of frames) {
    const id = (frame as unknown as { session_id?: string }).session_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  throw new Error("no session_id observed in the frame stream");
}

describe.skipIf(!ENABLED)("real Claude Code CLI", () => {
  it(
    "runs a version pre-probe at or above the supported floor",
    async () => {
      const runtime = await resolveRuntime();
      const version = await withDeadline(probeVersion(runtime.binaryPath), 30_000, "version probe");
      expect(compareVersions(version, CLAUDE_CLI_VERSION_FLOOR)).toBeGreaterThanOrEqual(0);
    },
    DEADLINE_MS,
  );

  it(
    "reports a first-party subscription account through accountInfo()",
    async () => {
      const runtime = await resolveRuntime();
      const controller = new AbortController();
      const options = buildQueryOptions({
        runtime,
        baseEnv: process.env,
        model: MODEL,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        persistSession: false,
        abortController: controller,
        stderr: () => {},
      });
      const active = sdkQuery({ prompt: neverEndingPrompt(controller.signal), options });
      try {
        const account = await withDeadline(active.accountInfo(), 25_000, "account probe");
        expect(account.apiProvider).toBe("firstParty");
        expect(typeof account.subscriptionType).toBe("string");
        expect(account.subscriptionType).not.toBe("");
      } finally {
        controller.abort();
        await active.return(undefined).catch(() => undefined);
      }
    },
    DEADLINE_MS,
  );

  it(
    "gives a resumed session a fresh maxTurns budget",
    async () => {
      const runtime = await resolveRuntime();
      const first = startGeneration({
        prompt: "Reply with the single word OK.",
        options: buildQueryOptions({
          runtime,
          baseEnv: process.env,
          model: MODEL,
          tools: [],
          allowedTools: [],
          mcpServers: {},
          maxTurns: 1,
          stderr: () => {},
        }),
      });
      const firstFrames = await withDeadline(collect(first.frames()), 60_000, "first generation");
      const sessionId = sessionIdOf(firstFrames);
      expect(firstFrames.some((frame) => frame.type === "assistant")).toBe(true);

      const second = startGeneration({
        prompt: "Reply with the single word OK.",
        options: buildQueryOptions({
          runtime,
          baseEnv: process.env,
          model: MODEL,
          tools: [],
          allowedTools: [],
          mcpServers: {},
          maxTurns: 1,
          resume: sessionId,
          stderr: () => {},
        }),
      });
      const secondFrames = await withDeadline(
        collect(second.frames()),
        60_000,
        "resumed generation",
      );

      expect(sessionIdOf(secondFrames)).toBe(sessionId);
      expect(secondFrames.some((frame) => frame.type === "assistant")).toBe(true);
    },
    DEADLINE_MS,
  );

  it(
    "accepts the session-persistence knob",
    async () => {
      const runtime = await resolveRuntime();
      const options = buildQueryOptions({
        runtime,
        baseEnv: process.env,
        model: MODEL,
        tools: [],
        allowedTools: [],
        mcpServers: {},
        maxTurns: 1,
        persistSession: false,
        stderr: () => {},
      });
      expect(options.persistSession).toBe(false);

      const generation = startGeneration({ prompt: "Reply with the single word OK.", options });
      const frames = await withDeadline(collect(generation.frames()), 60_000, "stateless one-shot");
      expect(frames.some((frame) => frame.type === "result")).toBe(true);
      expect(generation.lastResult()).not.toBeNull();
    },
    DEADLINE_MS,
  );
});
