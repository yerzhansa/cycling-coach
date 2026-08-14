import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { tool, zodSchema, type ModelMessage, type ToolSet } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  claudeCliGenerateText,
  type ClaudeCliBridgePorts,
} from "../../src/agent/claude-cli/bridge.js";
import {
  CLAUDE_CLI_CHAT_LANE,
  CLAUDE_CLI_DISABLED_MESSAGE,
  CLAUDE_CLI_KILL_SWITCH_ENV,
  claudeCliSessionKey,
  createClaudeCliSessionPool,
  hashHistory,
  isKillSwitchValue,
  type ClaudeCliSessionPool,
  type ClaudeCliSessionPoolConfig,
} from "../../src/agent/claude-cli/session-pool.js";
import { readCursorStore } from "../../src/agent/claude-cli/cursor-store.js";
import { createScriptedQuery, type ScriptedQueryState } from "./helpers/frame-script.js";
import { fixedClaudeWorkingArea } from "./helpers/working-area.js";

const BINARY = "/Users/tester/.local/bin/claude";
const CHAT_HASH = "0123456789abcdef";
const MODEL = "haiku";
const KEY = claudeCliSessionKey(CHAT_HASH, CLAUDE_CLI_CHAT_LANE, MODEL);
const HAPPY_SESSION = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const WORKING_AREA = "/Users/tester/Library/Caches/Enduragent/claude";

const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) {
    const dir = scratch.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-cli-pool-"));
  scratch.push(dir);
  return join(dir, "claude-cli-sessions.json");
}

interface Harness {
  pool: ClaudeCliSessionPool;
  config: ClaudeCliSessionPoolConfig;
  env: NodeJS.ProcessEnv;
  path: string;
}

function harness(overrides: { path?: string; enabled?: boolean; ids?: string[] } = {}): Harness {
  const path = overrides.path ?? storePath();
  const config: ClaudeCliSessionPoolConfig = {
    enabled: overrides.enabled ?? true,
    cursorStorePath: path,
  };
  const env: NodeJS.ProcessEnv = {};
  const ids = overrides.ids ?? [];
  let minted = 0;
  const pool = createClaudeCliSessionPool({
    config,
    baseEnv: env,
    newSessionId: () => ids[minted++] ?? `minted-${minted}`,
  });
  return { pool, config, env, path };
}

function baseEnv(): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", HOME: "/Users/tester", USER: "tester" };
}

function coachTools(): ToolSet {
  return {
    memory_read: tool({
      description: "Read durable memory",
      inputSchema: zodSchema(z.object({ section: z.string().describe("section name") })),
      execute: async () => "no memory yet",
    }),
  } as unknown as ToolSet;
}

function bridgePorts(
  scripts: readonly string[],
  pool?: ClaudeCliSessionPool,
): { ports: ClaudeCliBridgePorts; state: ScriptedQueryState } {
  const scripted = createScriptedQuery(scripts);
  return {
    ports: {
      runtime: { binaryPath: BINARY, billing: "subscription" },
      workingArea: fixedClaudeWorkingArea(WORKING_AREA),
      baseEnv: baseEnv(),
      query: scripted.query,
      pool,
    },
    state: scripted.state,
  };
}

function turn(messages: ModelMessage[], caller: "chat" | "flush" = "chat") {
  return {
    system: "You are the coach.",
    messages,
    tools: coachTools(),
    caller,
    cacheKey: CHAT_HASH,
    modelId: MODEL,
  };
}

const TURN_ONE: ModelMessage[] = [{ role: "user", content: "how is my week" }];
const TURN_TWO: ModelMessage[] = [
  { role: "user", content: "how is my week" },
  { role: "assistant", content: "Easy spin today." },
  { role: "user", content: "and tomorrow" },
];

describe("claude-cli kill switch parsing", () => {
  it("accepts 1/true case-insensitively and nothing else", () => {
    for (const value of ["1", "true", "TRUE", " True "]) {
      expect(isKillSwitchValue(value)).toBe(true);
    }
    for (const value of [undefined, "", "0", "false", "yes", "2"]) {
      expect(isKillSwitchValue(value)).toBe(false);
    }
  });
});

describe("claude-cli session pool resume/rebuild matrix", () => {
  it("rebuilds when no cursor exists and resumes after a commit", async () => {
    const { pool } = harness();
    const hash = hashHistory([]);

    const first = await pool.acquire(KEY, hash);
    expect(first).toEqual({ cursor: null, mode: "rebuild" });

    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: hash });

    const second = await pool.acquire(KEY, hash);
    expect(second.mode).toBe("resume");
    expect(second.cursor?.sessionId).toBe(HAPPY_SESSION);
    expect(second.cursor?.dirty).toBe(false);
  });

  it("rebuilds on a historyHash mismatch", async () => {
    const { pool } = harness();
    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-a" });

    const acquired = await pool.acquire(KEY, "hash-b");
    expect(acquired).toEqual({ cursor: null, mode: "rebuild" });
  });

  it("drops the cursor when a compact boundary marked it dirty before the commit", async () => {
    const { pool, path } = harness();
    await pool.acquire(KEY, "hash-a");
    pool.observeSessionId(KEY, HAPPY_SESSION);
    pool.markDirty(KEY);
    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-b" });

    expect(readCursorStore(path).cursors).toEqual({});
    expect(await pool.acquire(KEY, "hash-b")).toEqual({ cursor: null, mode: "rebuild" });
  });

  it("keeps the compact-boundary rebuild when a kill-switch dispose lands mid-turn", async () => {
    const { pool, env, path } = harness();
    await pool.acquire(KEY, "hash-a");
    pool.observeSessionId(KEY, HAPPY_SESSION);
    pool.markDirty(KEY);

    env[CLAUDE_CLI_KILL_SWITCH_ENV] = "1";
    await expect(pool.acquire(KEY, "hash-a")).rejects.toThrow(CLAUDE_CLI_DISABLED_MESSAGE);
    delete env[CLAUDE_CLI_KILL_SWITCH_ENV];

    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-b" });

    expect(readCursorStore(path).cursors).toEqual({});
    expect(await pool.acquire(KEY, "hash-b")).toEqual({ cursor: null, mode: "rebuild" });
  });

  it("clears the dirty mark once the rebuilt turn commits", async () => {
    const { pool, path } = harness();
    const rebuilt = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    await pool.acquire(KEY, "hash-a");
    pool.observeSessionId(KEY, HAPPY_SESSION);
    pool.markDirty(KEY);
    await pool.dispose();
    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-b" });

    await pool.commit(KEY, { sessionId: rebuilt, historyHash: "hash-c" });

    expect(readCursorStore(path).cursors[KEY]).toEqual({
      sessionId: rebuilt,
      historyHash: "hash-c",
    });
  });

  it("rebuilds after invalidate", async () => {
    const { pool } = harness();
    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-a" });
    pool.invalidate(KEY);

    expect(await pool.acquire(KEY, "hash-a")).toEqual({ cursor: null, mode: "rebuild" });
  });

  it("keeps separate cursors per lane key", async () => {
    const { pool } = harness();
    const other = claudeCliSessionKey(CHAT_HASH, CLAUDE_CLI_CHAT_LANE, "opus");
    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-a" });

    expect((await pool.acquire(other, "hash-a")).mode).toBe("rebuild");
    expect((await pool.acquire(KEY, "hash-a")).mode).toBe("resume");
  });
});

describe("claude-cli cursor store persistence", () => {
  it("writes the cursor file with mode 0600", async () => {
    const { pool, path } = harness();
    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-a" });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readCursorStore(path).cursors[KEY]).toEqual({
      sessionId: HAPPY_SESSION,
      historyHash: "hash-a",
    });
  });

  it("survives a daemon restart — a fresh pool reads the cursor back and resumes", async () => {
    const path = storePath();
    const first = harness({ path });
    await first.pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-a" });
    await first.pool.dispose();

    const second = harness({ path });
    const acquired = await second.pool.acquire(KEY, "hash-a");
    expect(acquired.mode).toBe("resume");
    expect(acquired.cursor?.sessionId).toBe(HAPPY_SESSION);
  });

  it("rebuilds when the cursor file is missing after a restart", async () => {
    const { pool } = harness();
    expect(await pool.acquire(KEY, "hash-a")).toEqual({ cursor: null, mode: "rebuild" });
  });

  it("quarantines a corrupt cursor file and resets to an empty store", async () => {
    const path = storePath();
    writeFileSync(path, "{ this is not json", { mode: 0o600 });

    const { pool } = harness({ path });
    expect(await pool.acquire(KEY, "hash-a")).toEqual({ cursor: null, mode: "rebuild" });

    expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("{ this is not json");
    expect(statSync(`${path}.corrupt`).mode & 0o777).toBe(0o600);

    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-a" });
    expect(readCursorStore(path).cursors[KEY]?.sessionId).toBe(HAPPY_SESSION);
  });

  it("quarantines a structurally invalid cursor document", async () => {
    const path = storePath();
    writeFileSync(path, JSON.stringify({ [KEY]: { sessionId: 42 } }), { mode: 0o600 });

    const { pool } = harness({ path });
    expect((await pool.acquire(KEY, "hash-a")).mode).toBe("rebuild");
    expect(readFileSync(`${path}.corrupt`, "utf8")).toContain('"sessionId":42');
  });

  it("does not clobber a second corrupt file — it takes the next quarantine slot", async () => {
    const path = storePath();
    writeFileSync(path, "first corruption", { mode: 0o600 });
    await harness({ path }).pool.acquire(KEY, "h");

    writeFileSync(path, "second corruption", { mode: 0o600 });
    await harness({ path }).pool.acquire(KEY, "h");

    expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("first corruption");
    expect(readFileSync(`${path}.corrupt.1`, "utf8")).toBe("second corruption");
  });
});

describe("claude-cli kill switch re-check on acquire", () => {
  it("refuses the turn with the exact disabled message when the env flag flips between turns", async () => {
    const { pool, env, path } = harness();
    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-a" });
    expect((await pool.acquire(KEY, "hash-a")).mode).toBe("resume");

    env[CLAUDE_CLI_KILL_SWITCH_ENV] = "TRUE";
    await expect(pool.acquire(KEY, "hash-a")).rejects.toThrow(CLAUDE_CLI_DISABLED_MESSAGE);

    expect(readCursorStore(path).cursors[KEY]?.sessionId).toBe(HAPPY_SESSION);

    delete env[CLAUDE_CLI_KILL_SWITCH_ENV];
    expect((await pool.acquire(KEY, "hash-a")).mode).toBe("resume");
  });

  it("refuses when the configured enable flag flips off", async () => {
    const { pool, config } = harness();
    await pool.commit(KEY, { sessionId: HAPPY_SESSION, historyHash: "hash-a" });

    config.enabled = false;
    await expect(pool.acquire(KEY, "hash-a")).rejects.toThrow(CLAUDE_CLI_DISABLED_MESSAGE);
  });

  it("refuses through the bridge so the turn never spawns the CLI", async () => {
    const { pool, env } = harness();
    env[CLAUDE_CLI_KILL_SWITCH_ENV] = "1";
    const { ports, state } = bridgePorts(["happy-turn"], pool);

    await expect(claudeCliGenerateText(turn(TURN_ONE), ports)).rejects.toThrow(
      CLAUDE_CLI_DISABLED_MESSAGE,
    );
    expect(state.calls).toBe(0);
  });
});

describe("claude-cli pool wiring through the bridge", () => {
  it("rebuilds the first turn and resumes the second with only the new user message", async () => {
    const { pool, path } = harness({ ids: ["minted-session-1"] });
    const { ports, state } = bridgePorts(["happy-turn", "happy-turn"], pool);

    await claudeCliGenerateText(turn(TURN_ONE), ports);

    expect(state.options[0].sessionId).toBe("minted-session-1");
    expect(state.options[0].resume).toBeUndefined();
    expect(state.options[0].cwd).toBe(WORKING_AREA);
    expect(readCursorStore(path).cursors[KEY]?.sessionId).toBe(HAPPY_SESSION);

    await claudeCliGenerateText(turn(TURN_TWO), ports);

    expect(state.calls).toBe(2);
    expect(state.options[1].resume).toBe(HAPPY_SESSION);
    expect(state.options[1].sessionId).toBeUndefined();
    expect(state.options[1].cwd).toBe(WORKING_AREA);
    expect(state.prompts[1]).toBe("and tomorrow");
  });

  it("renders prior history as a fenced transcript inside the first user message on rebuild", async () => {
    const { pool } = harness({ ids: ["minted-session-1"] });
    const { ports, state } = bridgePorts(["happy-turn"], pool);

    await claudeCliGenerateText(turn(TURN_TWO), ports);

    const prompt = state.prompts[0] as string;
    expect(prompt).toContain("<conversation-transcript>");
    expect(prompt).toContain("user: how is my week");
    expect(prompt).toContain("assistant: Easy spin today.");
    expect(prompt).toContain("</conversation-transcript>");
    expect(prompt.endsWith("and tomorrow")).toBe(true);
    expect(state.options[0].systemPrompt).toBe("You are the coach.");
  });

  it("rebuilds the next turn after a compact_boundary frame", async () => {
    const { pool, path } = harness({ ids: ["minted-session-1", "minted-session-2"] });
    const { ports, state } = bridgePorts(["compact-boundary-then-result", "happy-turn"], pool);

    const first = await claudeCliGenerateText(turn(TURN_ONE), ports);
    expect(first.text).toBe("Recovered and answering.");
    expect(readCursorStore(path).cursors).toEqual({});

    const next: ModelMessage[] = [
      { role: "user", content: "how is my week" },
      { role: "assistant", content: "Recovered and answering." },
      { role: "user", content: "and tomorrow" },
    ];
    await claudeCliGenerateText(turn(next), ports);

    expect(state.options[1].resume).toBeUndefined();
    expect(state.options[1].sessionId).toBe("minted-session-2");
    expect(state.options[0].sessionId).toBe("minted-session-1");
    expect(state.options.map((options) => options.cwd)).toEqual([WORKING_AREA, WORKING_AREA]);
  });

  it("falls back to a rebuild when the resume is refused by the CLI", async () => {
    const { pool } = harness({ ids: ["minted-session-1", "minted-session-2"] });
    const { ports, state } = bridgePorts(["happy-turn", "resume-conflict", "happy-turn"], pool);

    await claudeCliGenerateText(turn(TURN_ONE), ports);
    const second = await claudeCliGenerateText(turn(TURN_TWO), ports);

    expect(state.calls).toBe(3);
    expect(state.options[1].resume).toBe(HAPPY_SESSION);
    expect(state.options[2].resume).toBeUndefined();
    expect(state.options[2].sessionId).toBe("minted-session-2");
    expect(state.options.map((options) => options.cwd)).toEqual([
      WORKING_AREA,
      WORKING_AREA,
      WORKING_AREA,
    ]);
    expect(state.prompts[2]).toContain("<conversation-transcript>");
    expect(second.text).toBe("Easy spin today.");
  });

  it("surfaces a taxonomy error whose message merely mentions resuming", async () => {
    const { pool, path } = harness({ ids: ["minted-session-1", "minted-session-2"] });
    const { ports, state } = bridgePorts(
      ["happy-turn", "rate-limit-mentioning-resume", "happy-turn"],
      pool,
    );

    await claudeCliGenerateText(turn(TURN_ONE), ports);
    await expect(claudeCliGenerateText(turn(TURN_TWO), ports)).rejects.toMatchObject({
      name: "RateLimitError",
    });

    expect(state.calls).toBe(2);
    await pool.dispose();
    expect(readCursorStore(path).cursors[KEY]?.sessionId).toBe(HAPPY_SESSION);
  });

  it("replays exactly once when the resumed subprocess dies mid-stream", async () => {
    const { pool } = harness({ ids: ["minted-session-1", "minted-session-2"] });
    const { ports, state } = bridgePorts(["happy-turn", "die-mid-stream", "happy-turn"], pool);

    await claudeCliGenerateText(turn(TURN_ONE), ports);
    const second = await claudeCliGenerateText(turn(TURN_TWO), ports);

    expect(state.calls).toBe(3);
    expect(state.options[1].resume).toBe(HAPPY_SESSION);
    expect(state.options[2].resume).toBeUndefined();
    expect(state.options[2].sessionId).toBe("minted-session-2");
    expect(second.text).toBe("Easy spin today.");
  });

  it("surfaces a second death as a terminal NetworkError instead of a third attempt", async () => {
    const { pool, path } = harness({ ids: ["minted-session-1", "minted-session-2"] });
    const { ports, state } = bridgePorts(["happy-turn", "die-mid-stream", "die-mid-stream"], pool);

    await claudeCliGenerateText(turn(TURN_ONE), ports);
    await expect(claudeCliGenerateText(turn(TURN_TWO), ports)).rejects.toMatchObject({
      name: "NetworkError",
    });

    expect(state.calls).toBe(3);
    await pool.dispose();
    expect(readCursorStore(path).cursors).toEqual({});
  });

  it("rebuilds after a daemon restart whose cursor file was corrupted", async () => {
    const path = storePath();
    const first = harness({ path, ids: ["minted-session-1"] });
    await claudeCliGenerateText(turn(TURN_ONE), bridgePorts(["happy-turn"], first.pool).ports);
    await first.pool.dispose();

    writeFileSync(path, "corrupted between runs", { mode: 0o600 });

    const second = harness({ path, ids: ["minted-session-9"] });
    const { ports, state } = bridgePorts(["happy-turn"], second.pool);
    await claudeCliGenerateText(turn(TURN_TWO), ports);

    expect(state.options[0].resume).toBeUndefined();
    expect(state.options[0].sessionId).toBe("minted-session-9");
    expect(readFileSync(`${path}.corrupt`, "utf8")).toBe("corrupted between runs");
  });

  it("routes flush and compact callers to stateless one-shots that bypass the pool", async () => {
    const { pool, path } = harness();
    const acquire = vi.spyOn(pool, "acquire");
    const { ports, state } = bridgePorts(["happy-turn"], pool);

    await claudeCliGenerateText(turn(TURN_TWO, "flush"), ports);

    expect(acquire).not.toHaveBeenCalled();
    const options = state.options[0];
    expect(options.persistSession).toBe(false);
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(Object.keys(options.mcpServers as Record<string, unknown>)).toEqual([]);
    expect(options.resume).toBeUndefined();
    expect(options.sessionId).toBeUndefined();
    expect(options.cwd).toBe(WORKING_AREA);
    expect(readCursorStore(path).cursors).toEqual({});
  });

  it("keeps chat turns stateful — persistSession is never disabled on the pooled lane", async () => {
    const { pool } = harness({ ids: ["minted-session-1"] });
    const { ports, state } = bridgePorts(["happy-turn"], pool);

    await claudeCliGenerateText(turn(TURN_ONE), ports);

    expect(state.options[0].persistSession).toBeUndefined();
    expect(Object.keys(state.options[0].mcpServers as Record<string, unknown>)).toEqual(["coach"]);
  });
});
