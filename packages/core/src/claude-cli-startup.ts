import {
  ClaudeCliConfigError,
  ensureClaudeCliReady,
  type ClaudeCliReadiness,
} from "@enduragent/engine";

import { CLAUDE_CLI_DISABLED_MESSAGE, type ClaudeCliRuntimeSettings } from "./runtime-config.js";

export interface ClaudeCliStartupGateInput {
  readonly settings: ClaudeCliRuntimeSettings | undefined;
  readonly model: string;
}

export interface ClaudeCliStartupGateDeps {
  readonly ensureReady?: typeof ensureClaudeCliReady;
  readonly log?: (line: string) => void;
  readonly refuse?: (message: string) => void;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export async function runClaudeCliStartupGate(
  input: ClaudeCliStartupGateInput,
  deps: ClaudeCliStartupGateDeps = {},
): Promise<ClaudeCliReadiness | null> {
  const ensureReady = deps.ensureReady ?? ensureClaudeCliReady;
  const log = deps.log ?? ((line: string) => console.log(line));
  const refuse =
    deps.refuse ??
    ((message: string) => {
      console.error(message);
      process.exit(1);
    });

  const settings = input.settings;
  if (settings?.enabled === false) {
    refuse(CLAUDE_CLI_DISABLED_MESSAGE);
    return null;
  }

  let readiness: ClaudeCliReadiness;
  try {
    readiness = await ensureReady(
      {
        ...(settings?.binaryPath === undefined ? {} : { binaryPath: settings.binaryPath }),
        ...(settings?.configDir === undefined ? {} : { configDir: settings.configDir }),
        billing: settings?.billing ?? "subscription",
        model: input.model,
        ...(deps.baseEnv === undefined ? {} : { baseEnv: deps.baseEnv }),
      },
      {},
    );
  } catch (err) {
    if (err instanceof ClaudeCliConfigError) {
      refuse(err.message);
      return null;
    }
    const detail = err instanceof Error ? err.message : String(err);
    refuse(`Claude Code CLI startup check failed: ${detail}`);
    return null;
  }

  log(readiness.identityLine);
  return readiness;
}
