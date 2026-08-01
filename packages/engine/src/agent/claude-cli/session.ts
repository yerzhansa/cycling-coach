import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { buildChildEnv, type ClaudeCliRuntime } from "./env.js";
import { normalizeClaudeCliError } from "./errors.js";

export type ClaudeCliPrompt = string | AsyncIterable<SDKUserMessage>;

export type SanitizedQueryOptions = Options & {
  env: NonNullable<Options["env"]>;
  pathToClaudeCodeExecutable: string;
  model: string;
};

export interface BuildQueryOptionsInput {
  runtime: ClaudeCliRuntime;
  baseEnv: NodeJS.ProcessEnv;
  model: string;
  systemPrompt?: string;
  mcpServers?: Options["mcpServers"];
  tools?: string[];
  allowedTools?: string[];
  canUseTool?: Options["canUseTool"];
  maxTurns?: number;
  resume?: string;
  sessionId?: string;
  cwd?: string;
  persistSession?: boolean;
  includePartialMessages?: boolean;
  abortController?: AbortController;
  stderr?: (data: string) => void;
}

export function buildQueryOptions(input: BuildQueryOptionsInput): SanitizedQueryOptions {
  const binaryPath = input.runtime.binaryPath;
  if (binaryPath === undefined || binaryPath === "") {
    throw new Error("Claude CLI query options require an explicit resolved binary path.");
  }
  if (input.model === undefined || input.model === "") {
    throw new Error("Claude CLI query options require an explicit model.");
  }
  if (input.resume !== undefined && input.sessionId !== undefined) {
    throw new Error("Claude CLI query options accept either resume or sessionId, not both.");
  }

  const env = {
    ...buildChildEnv(input.baseEnv, input.runtime),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  };

  const options: SanitizedQueryOptions = {
    pathToClaudeCodeExecutable: binaryPath,
    model: input.model,
    env,
    strictMcpConfig: true,
    settingSources: [],
    mcpServers: input.mcpServers ?? {},
  };

  if (input.systemPrompt !== undefined) options.systemPrompt = input.systemPrompt;
  if (input.tools !== undefined) options.tools = input.tools;
  if (input.allowedTools !== undefined) options.allowedTools = input.allowedTools;
  if (input.canUseTool !== undefined) options.canUseTool = input.canUseTool;
  if (input.maxTurns !== undefined) options.maxTurns = input.maxTurns;
  if (input.resume !== undefined) options.resume = input.resume;
  if (input.sessionId !== undefined) options.sessionId = input.sessionId;
  if (input.cwd !== undefined) options.cwd = input.cwd;
  if (input.persistSession !== undefined) options.persistSession = input.persistSession;
  if (input.includePartialMessages !== undefined) {
    options.includePartialMessages = input.includePartialMessages;
  }
  if (input.abortController !== undefined) options.abortController = input.abortController;
  if (input.stderr !== undefined) options.stderr = input.stderr;

  return options;
}

export interface ClaudeCliGeneration {
  frames(): AsyncIterable<SDKMessage>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  lastResult(): SDKResultMessage | null;
  iterationError(): unknown;
}

export interface StartGenerationDeps {
  query?: typeof sdkQuery;
}

export interface StartGenerationSpec {
  prompt: ClaudeCliPrompt;
  options: SanitizedQueryOptions;
}

export function startGeneration(
  spec: StartGenerationSpec,
  deps: StartGenerationDeps = {},
): ClaudeCliGeneration {
  const run = deps.query ?? sdkQuery;
  const active: Query = run({ prompt: spec.prompt, options: spec.options });

  let started = false;
  let closed = false;
  let result: SDKResultMessage | null = null;
  let caught: unknown = null;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await active.return(undefined);
    } catch {
      return;
    }
  };

  const frames = async function* (): AsyncGenerator<SDKMessage, void> {
    if (started) {
      throw new Error("Claude CLI generation frames() may only be consumed once.");
    }
    started = true;
    try {
      for await (const message of active) {
        if (message.type === "result") result = message;
        yield message;
      }
    } catch (err) {
      caught = err;
      if (result === null) {
        throw normalizeClaudeCliError(err);
      }
    } finally {
      await close();
    }
  };

  return {
    frames,
    interrupt: async (): Promise<void> => {
      if (closed) return;
      await active.interrupt();
    },
    close,
    lastResult: () => result,
    iterationError: () => caught,
  };
}
