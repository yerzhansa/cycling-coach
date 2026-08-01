import { describe, expect, it } from "vitest";
import type { query as sdkQuery, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCliRuntime } from "../../src/agent/claude-cli/env.js";
import {
  buildQueryOptions,
  startGeneration,
  type SanitizedQueryOptions,
} from "../../src/agent/claude-cli/session.js";

const SENTINEL = "sk-ant-sentinel-session-0000";

const RUNTIME: ClaudeCliRuntime = {
  binaryPath: "/Users/tester/.local/bin/claude",
  billing: "subscription",
};

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: "/Users/tester",
    USER: "tester",
    ANTHROPIC_API_KEY: SENTINEL,
    CLAUDE_CODE_OAUTH_TOKEN: SENTINEL,
  };
}

function options(overrides: Partial<Parameters<typeof buildQueryOptions>[0]> = {}) {
  return buildQueryOptions({
    runtime: RUNTIME,
    baseEnv: baseEnv(),
    model: "haiku",
    ...overrides,
  });
}

interface FakeQueryState {
  calls: number;
  lastArgs: { prompt: unknown; options?: unknown } | null;
  returnCalls: number;
  interrupts: number;
}

function makeFakeQuery(messages: SDKMessage[], throwAtEnd?: unknown) {
  const state: FakeQueryState = { calls: 0, lastArgs: null, returnCalls: 0, interrupts: 0 };
  const call = (args: { prompt: unknown; options?: unknown }) => {
    state.calls += 1;
    state.lastArgs = args;
    const inner = (async function* () {
      for (const message of messages) yield message;
      if (throwAtEnd !== undefined) throw throwAtEnd;
    })();
    const q = {
      [Symbol.asyncIterator]() {
        return q;
      },
      next: () => inner.next(),
      return: async (value: unknown) => {
        state.returnCalls += 1;
        return inner.return(value as undefined);
      },
      throw: (err: unknown) => inner.throw(err),
      interrupt: async () => {
        state.interrupts += 1;
        return undefined;
      },
    };
    return q;
  };
  return { query: call as unknown as typeof sdkQuery, state };
}

function systemFrame(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  } as unknown as SDKMessage;
}

function resultFrame(isError: boolean): SDKMessage {
  return {
    type: "result",
    subtype: isError ? "error_during_execution" : "success",
    is_error: isError,
    session_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    total_cost_usd: 0.001,
  } as unknown as SDKMessage;
}

async function drain(iterable: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const seen: SDKMessage[] = [];
  for await (const message of iterable) seen.push(message);
  return seen;
}

describe("buildQueryOptions", () => {
  it("always pins the resolved executable and an explicit model", () => {
    const built = options();
    expect(built.pathToClaudeCodeExecutable).toBe(RUNTIME.binaryPath);
    expect(built.model).toBe("haiku");
  });

  it("supplies a sanitized, non-optional child environment", () => {
    const built: SanitizedQueryOptions = options();
    expect(built.env.PATH).toBe("/usr/bin:/bin");
    expect(built.env.HOME).toBe("/Users/tester");
    expect(built.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(built.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(built.env)).not.toContain(SENTINEL);
  });

  it("disables the hosted MCP server catalogue and filesystem settings sources", () => {
    const built = options();
    expect(built.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
    expect(built.strictMcpConfig).toBe(true);
    expect(built.settingSources).toEqual([]);
  });

  it("never permits a permission bypass", () => {
    const built = options({ tools: [], allowedTools: [] });
    expect("permissionMode" in built).toBe(false);
    expect("allowDangerouslySkipPermissions" in built).toBe(false);
    expect(JSON.stringify(built)).not.toContain("bypassPermissions");
  });

  it("passes an api-key through only when the instance opted into api-key billing", () => {
    const subscription = options();
    expect(subscription.env.ANTHROPIC_API_KEY).toBeUndefined();

    const apiKey = buildQueryOptions({
      runtime: { ...RUNTIME, billing: "api-key" },
      baseEnv: baseEnv(),
      model: "haiku",
    });
    expect(apiKey.env.ANTHROPIC_API_KEY).toBe(SENTINEL);
  });

  it("carries the optional generation knobs it was given", () => {
    const built = options({
      systemPrompt: "coach prompt",
      tools: ["mcp__coach__memory_read"],
      allowedTools: ["mcp__coach__memory_read"],
      maxTurns: 10,
      resume: "session-1",
      includePartialMessages: true,
      persistSession: false,
      cwd: "/tmp/scratch",
    });
    expect(built.systemPrompt).toBe("coach prompt");
    expect(built.tools).toEqual(["mcp__coach__memory_read"]);
    expect(built.allowedTools).toEqual(["mcp__coach__memory_read"]);
    expect(built.maxTurns).toBe(10);
    expect(built.resume).toBe("session-1");
    expect(built.includePartialMessages).toBe(true);
    expect(built.persistSession).toBe(false);
    expect(built.cwd).toBe("/tmp/scratch");
  });

  it("refuses an empty model", () => {
    expect(() => options({ model: "" })).toThrow(/explicit model/);
  });

  it("refuses a runtime without a resolved binary path", () => {
    expect(() => options({ runtime: { ...RUNTIME, binaryPath: "" } })).toThrow(
      /explicit resolved binary path/,
    );
  });

  it("refuses both resume and a fresh session id at once", () => {
    expect(() => options({ resume: "a", sessionId: "b" })).toThrow(/resume or sessionId/);
  });
});

describe("startGeneration", () => {
  it("runs exactly one query and yields its frames in order", async () => {
    const frames = [systemFrame(), resultFrame(false)];
    const fake = makeFakeQuery(frames);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });

    const seen = await drain(generation.frames());

    expect(fake.state.calls).toBe(1);
    expect(seen).toEqual(frames);
    expect(fake.state.lastArgs?.prompt).toBe("hi");
  });

  it("retains the last result frame", async () => {
    const fake = makeFakeQuery([systemFrame(), resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await drain(generation.frames());
    expect(generation.lastResult()).toEqual(resultFrame(false));
    expect(generation.iterationError()).toBeNull();
  });

  it("survives the iterator throwing after an is_error result", async () => {
    const thrown = new Error("Claude Code returned an error result: rate limit reached");
    const fake = makeFakeQuery([systemFrame(), resultFrame(true)], thrown);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });

    const seen = await drain(generation.frames());

    expect(seen).toHaveLength(2);
    expect(generation.lastResult()).toEqual(resultFrame(true));
    expect(generation.iterationError()).toBe(thrown);
  });

  it("throws a normalized error when the iterator dies before any result", async () => {
    const thrown = new Error("Claude Code process exited with code 1");
    const fake = makeFakeQuery([systemFrame()], thrown);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });

    await expect(drain(generation.frames())).rejects.toMatchObject({ name: "NetworkError" });
    expect(generation.lastResult()).toBeNull();
  });

  it("refuses a second frame consumer", async () => {
    const fake = makeFakeQuery([resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await drain(generation.frames());
    await expect(drain(generation.frames())).rejects.toThrow(/only be consumed once/);
  });

  it("forwards interrupt to the running query", async () => {
    const fake = makeFakeQuery([resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await generation.interrupt();
    expect(fake.state.interrupts).toBe(1);
  });

  it("stops forwarding interrupt once closed", async () => {
    const fake = makeFakeQuery([resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await generation.close();
    await generation.interrupt();
    expect(fake.state.interrupts).toBe(0);
  });

  it("closes idempotently", async () => {
    const fake = makeFakeQuery([resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    await generation.close();
    await generation.close();
    await generation.close();
    expect(fake.state.returnCalls).toBe(1);
  });

  it("closes the query when frame iteration ends early", async () => {
    const fake = makeFakeQuery([systemFrame(), resultFrame(false)]);
    const generation = startGeneration({ prompt: "hi", options: options() }, { query: fake.query });
    for await (const _message of generation.frames()) break;
    const afterBreak = fake.state.returnCalls;
    expect(afterBreak).toBeGreaterThanOrEqual(1);
    await generation.close();
    expect(fake.state.returnCalls).toBe(afterBreak);
  });
});
