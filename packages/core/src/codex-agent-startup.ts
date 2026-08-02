import {
  CodexAgentConfigError,
  ensureCodexAgentReady,
  type CodexAgentReadinessReport,
  type CodexAgentReadinessResult,
} from "@enduragent/engine";

import {
  CODEX_AGENT_DISABLED_MESSAGE,
  CODEX_AGENT_WINDOWS_MESSAGE,
  type CodexAgentRuntimeSettings,
} from "./runtime-config.js";

export interface CodexAgentStartupGateInput {
  readonly settings: CodexAgentRuntimeSettings | undefined;
  readonly model: string;
}

export interface CodexAgentStartupGateDeps {
  readonly ensureReady?: typeof ensureCodexAgentReady;
  readonly log?: (line: string) => void;
  readonly refuse?: (message: string) => void;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

function refusalMessage(err: unknown): string {
  if (err instanceof CodexAgentConfigError) return err.message;
  const detail = err instanceof Error ? err.message : String(err);
  return `Codex CLI startup check failed: ${detail}`;
}

export async function runCodexAgentStartupGate(
  input: CodexAgentStartupGateInput,
  deps: CodexAgentStartupGateDeps = {},
): Promise<CodexAgentReadinessReport | null> {
  const ensureReady = deps.ensureReady ?? ensureCodexAgentReady;
  const log = deps.log ?? ((line: string) => console.log(line));
  const refuse =
    deps.refuse ??
    ((message: string) => {
      console.error(message);
      process.exit(1);
    });

  const platform = deps.platform ?? process.platform;
  if (platform === "win32") {
    refuse(CODEX_AGENT_WINDOWS_MESSAGE);
    return null;
  }

  const settings = input.settings;
  if (settings?.enabled !== true) {
    refuse(CODEX_AGENT_DISABLED_MESSAGE);
    return null;
  }

  let result: CodexAgentReadinessResult;
  try {
    result = await ensureReady(
      {
        ...(settings.binaryPath === undefined ? {} : { binaryPath: settings.binaryPath }),
        model: input.model,
        ...(deps.baseEnv === undefined ? {} : { baseEnv: deps.baseEnv }),
      },
      {},
    );
  } catch (err) {
    refuse(refusalMessage(err));
    return null;
  }

  if (result.status === "refused") {
    refuse(refusalMessage(result.error));
    return null;
  }

  log(result.identityLine);
  return result;
}
