import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { query as sdkQuery, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { FAKE_CLAUDE_SCRIPTS_DIR } from "./fake-claude.js";

export type ScriptTerminal = { kind: "end" } | { kind: "throw"; error: Error } | { kind: "hang" };

export interface LoadedFrameScript {
  frames: SDKMessage[];
  terminal: ScriptTerminal;
}

export function loadFrameScript(name: string): LoadedFrameScript {
  const raw = readFileSync(join(FAKE_CLAUDE_SCRIPTS_DIR, `${name}.ndjson`), "utf8");
  const frames: SDKMessage[] = [];
  let terminal: ScriptTerminal = { kind: "end" };
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const control = parsed.__control;
    if (control === undefined) {
      frames.push(parsed as unknown as SDKMessage);
      continue;
    }
    if (control === "exit") {
      const code = typeof parsed.code === "number" ? parsed.code : 0;
      terminal = {
        kind: "throw",
        error: new Error(`Claude Code process exited with code ${code}`),
      };
      break;
    }
    if (control === "hang") {
      terminal = { kind: "hang" };
      break;
    }
  }
  return { frames, terminal };
}

export interface ScriptedQueryState {
  calls: number;
  scripts: string[];
  prompts: unknown[];
  options: Array<Record<string, unknown>>;
  interrupts: number;
  returns: number;
}

export interface ScriptedQuery {
  query: typeof sdkQuery;
  state: ScriptedQueryState;
}

interface ScriptedAccountChannel {
  account: Record<string, unknown> | null;
  initialization: Record<string, unknown> | null;
}

function accountChannelFor(frames: readonly SDKMessage[]): ScriptedAccountChannel {
  const init = frames.find(
    (frame) =>
      (frame as unknown as Record<string, unknown>).type === "system" &&
      (frame as unknown as Record<string, unknown>).subtype === "init",
  ) as Record<string, unknown> | undefined;
  if (init === undefined) return { account: null, initialization: null };
  const account = init.account;
  return {
    initialization: init,
    account:
      typeof account === "object" && account !== null
        ? (account as Record<string, unknown>)
        : null,
  };
}

export function createScriptedQuery(scripts: readonly string[]): ScriptedQuery {
  const state: ScriptedQueryState = {
    calls: 0,
    scripts: [],
    prompts: [],
    options: [],
    interrupts: 0,
    returns: 0,
  };

  const call = (args: { prompt: unknown; options?: unknown }) => {
    const name = scripts[Math.min(state.calls, scripts.length - 1)] ?? "happy-turn";
    state.calls += 1;
    state.scripts.push(name);
    state.prompts.push(args.prompt);
    state.options.push((args.options ?? {}) as Record<string, unknown>);
    const script = loadFrameScript(name);

    const inner = (async function* () {
      for (const frame of script.frames) yield frame;
      if (script.terminal.kind === "throw") throw script.terminal.error;
      if (script.terminal.kind === "hang") await new Promise(() => undefined);
    })();

    const channel = accountChannelFor(script.frames);
    const pending = new Promise<never>(() => undefined);

    const q = {
      [Symbol.asyncIterator]() {
        return q;
      },
      initializationResult: async () => {
        if (channel.initialization === null) return await pending;
        return { ...channel.initialization, account: channel.account ?? undefined };
      },
      accountInfo: async () => {
        if (channel.initialization === null) return await pending;
        if (channel.account === null) throw new Error("no account channel");
        return channel.account;
      },
      next: () => inner.next(),
      return: async (value: unknown) => {
        state.returns += 1;
        void inner.return(value as undefined);
        return { value: undefined, done: true };
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
