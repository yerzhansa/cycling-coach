import { readFile } from "node:fs/promises";
import {
  ClaudeCliConfigError,
  claudeCliPatchFrom,
  ensureClaudeCliReady,
  invalidateClaudeAccountProbeCache,
  type ClaudeCliBilling,
  type ClaudeCliReadiness,
  type EnsureClaudeCliReadyDeps,
} from "@enduragent/core";
import type { ConfigureRuntimeRpcParams } from "@enduragent/coach-contract";
import { parse } from "yaml";
import {
  isClaudeCliLaneEligible,
  parseClaudeCliLlmSelection,
  runtimeConfigurationForSelection,
  type OnboardingLlmSelection,
  type OnboardingLlmSelectionResult,
} from "./llm-selection.js";

export const CLAUDE_CLI_STATUS_STATES = [
  "ready",
  "ready-api-key",
  "absent-binary",
  "not-logged-in",
  "api-key-token",
  "disabled",
] as const;

export type ClaudeCliStatusState = (typeof CLAUDE_CLI_STATUS_STATES)[number];

export interface ClaudeCliStatus {
  readonly state: ClaudeCliStatusState;
  readonly email?: string;
  readonly plan?: string;
  readonly version?: string;
}

export interface ClaudeCliSettings {
  readonly enabled: boolean;
  readonly binaryPath?: string;
  readonly configDir?: string;
  readonly billing: ClaudeCliBilling;
}

export interface ClaudeCliStatusController {
  status(): Promise<ClaudeCliStatus>;
  recheck(): Promise<ClaudeCliStatus>;
  invalidateProbeCache(): void;
  activate(selection: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
}

export type ClaudeCliStatusDependencies = Pick<
  EnsureClaudeCliReadyDeps,
  "resolveBinary" | "probeVersion" | "probeAccount"
> & {
  readonly ensureReady?: typeof ensureClaudeCliReady;
  readonly invalidateProbeCache?: () => void;
};

export interface CreateClaudeCliStatusOptions {
  readonly settings: () => ClaudeCliSettings | Promise<ClaudeCliSettings>;
  readonly environment?: () => Readonly<Record<string, string | undefined>>;
  readonly applyRuntimeConfig: (request: ConfigureRuntimeRpcParams) => Promise<void>;
  readonly dependencies?: ClaudeCliStatusDependencies;
}

export interface ReadClaudeCliSettingsInput {
  readonly configPath: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly readConfigFile?: (path: string) => Promise<string>;
  readonly parseConfigFile?: (source: string) => unknown;
}

const CONFIG_FILE_LIMIT = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claudeCliYamlBlock(document: unknown): unknown {
  if (!isRecord(document) || !isRecord(document.llm)) return undefined;
  return document.llm.claude_cli;
}

export async function readClaudeCliSettings(
  input: ReadClaudeCliSettingsInput,
): Promise<ClaudeCliSettings> {
  const environment = input.environment ?? process.env;
  const read = input.readConfigFile ?? ((path: string) => readFile(path, "utf8"));
  const parseDocument = input.parseConfigFile ?? ((source: string) => parse(source) as unknown);
  let block: unknown;
  try {
    const source = await read(input.configPath);
    if (source.length <= CONFIG_FILE_LIMIT) block = claudeCliYamlBlock(parseDocument(source));
  } catch {
    block = undefined;
  }
  const patch = claudeCliPatchFrom(block, environment);
  const binaryPath = typeof patch.binaryPath === "string" ? patch.binaryPath : undefined;
  const configDir = typeof patch.configDir === "string" ? patch.configDir : undefined;
  return {
    enabled: patch.enabled !== false,
    ...(binaryPath === undefined ? {} : { binaryPath }),
    ...(configDir === undefined ? {} : { configDir }),
    billing: patch.billing === "api-key" ? "api-key" : "subscription",
  };
}

function statusForReadiness(readiness: ClaudeCliReadiness): ClaudeCliStatus {
  return {
    state: readiness.accountClass === "api-key-token" ? "ready-api-key" : "ready",
    ...(readiness.email === undefined ? {} : { email: readiness.email }),
    ...(readiness.plan === undefined ? {} : { plan: readiness.plan }),
    version: readiness.version,
  };
}

function stateForFailure(error: unknown): ClaudeCliStatusState {
  if (!(error instanceof ClaudeCliConfigError)) return "not-logged-in";
  switch (error.kind) {
    case "binary-missing":
    case "version-below-floor":
      return "absent-binary";
    case "api-key-identity":
    case "api-key-unapproved":
    case "unrecognized-auth-source":
      return "api-key-token";
    default:
      return "not-logged-in";
  }
}

export function createClaudeCliStatus(
  options: CreateClaudeCliStatusOptions,
): ClaudeCliStatusController {
  const ensureReady = options.dependencies?.ensureReady ?? ensureClaudeCliReady;
  const invalidate =
    options.dependencies?.invalidateProbeCache ?? invalidateClaudeAccountProbeCache;
  const environment = options.environment ?? (() => process.env);
  const probeDependencies: EnsureClaudeCliReadyDeps = {
    ...(options.dependencies?.resolveBinary === undefined
      ? {}
      : { resolveBinary: options.dependencies.resolveBinary }),
    ...(options.dependencies?.probeVersion === undefined
      ? {}
      : { probeVersion: options.dependencies.probeVersion }),
    ...(options.dependencies?.probeAccount === undefined
      ? {}
      : { probeAccount: options.dependencies.probeAccount }),
  };

  const read = async (forceRecheck: boolean): Promise<ClaudeCliStatus> => {
    let settings: ClaudeCliSettings;
    try {
      settings = await options.settings();
    } catch {
      return { state: "not-logged-in" };
    }
    if (!isClaudeCliLaneEligible({ environment: environment(), enabled: settings.enabled })) {
      return { state: "disabled" };
    }
    try {
      return statusForReadiness(
        await ensureReady(
          {
            ...(settings.binaryPath === undefined ? {} : { binaryPath: settings.binaryPath }),
            ...(settings.configDir === undefined ? {} : { configDir: settings.configDir }),
            billing: settings.billing,
            ...(forceRecheck ? { forceRecheck: true } : {}),
          },
          probeDependencies,
        ),
      );
    } catch (error) {
      return { state: stateForFailure(error) };
    }
  };

  return {
    status: () => read(false),
    async recheck() {
      invalidate();
      return await read(true);
    },
    invalidateProbeCache: () => invalidate(),
    async activate(input) {
      let selection: ReturnType<typeof parseClaudeCliLlmSelection>;
      try {
        selection = parseClaudeCliLlmSelection(input);
      } catch {
        return { status: "refused", reason: "invalid-input" };
      }
      const current = await read(false);
      if (current.state === "disabled") {
        return { status: "refused", reason: "runtime-unavailable" };
      }
      if (current.state !== "ready" && current.state !== "ready-api-key") {
        return { status: "refused", reason: "credential-required" };
      }
      try {
        await options.applyRuntimeConfig(runtimeConfigurationForSelection(selection));
      } catch {
        return { status: "refused", reason: "runtime-unavailable" };
      }
      return { status: "configured", runtimeReady: true };
    },
  };
}
