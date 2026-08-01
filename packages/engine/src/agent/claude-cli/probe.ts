import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  query as sdkQuery,
  type AccountInfo,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { ClaudeCliBilling, ClaudeCliRuntime } from "./env.js";
import {
  apiKeyIdentityError,
  apiKeyUnapprovedError,
  binaryMissingError,
  notSignedInError,
  probeTimeoutError,
  unrecognizedAuthSourceError,
  type ClaudeCliConfigError,
} from "./errors.js";
import {
  assertVersionAtLeast,
  probeVersion,
  resolveClaudeBinary,
  CLAUDE_CLI_VERSION_FLOOR,
} from "./executable.js";
import { buildQueryOptions } from "./session.js";

export const ACCOUNT_PROBE_TIMEOUT_MS = 25_000;
export const ACCOUNT_PROBE_RETRY_DELAY_MS = 750;
export const ACCOUNT_PROBE_MODEL = "haiku";

export const API_KEY_BILLING_IDENTITY_LINE =
  "Using Anthropic API key billing - usage is charged to your API account.";

export type ClaudeAccountClass = "subscription" | "api-key-token" | "unrecognized";

export type ClaudeAccountProbeFailure = "timeout" | "no-account";

export interface ClaudeAccountProbeResult {
  readonly verified: boolean;
  readonly accountClass: ClaudeAccountClass;
  readonly reason?: ClaudeAccountProbeFailure;
  readonly email?: string;
  readonly plan?: string;
  readonly rawAuthSource?: string;
}

const API_KEY_TOKEN_SOURCES = new Set(["apikey", "anthropicapikey", "anthropicauthtoken"]);

const API_KEY_API_PROVIDERS = new Set(["bedrock", "vertex", "foundry"]);

function normalizeAuthToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function planLabel(subscriptionType: string): string {
  const withoutBrand = subscriptionType.replace(/^claude\s+/i, "").trim();
  const source = withoutBrand === "" ? subscriptionType.trim() : withoutBrand;
  return source
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export function classifyAccountInfo(account: AccountInfo | null | undefined): {
  readonly accountClass: ClaudeAccountClass;
  readonly email?: string;
  readonly plan?: string;
  readonly rawAuthSource?: string;
} {
  if (account === null || account === undefined || typeof account !== "object") {
    return { accountClass: "unrecognized", rawAuthSource: "missing account" };
  }

  const tokenSource = nonEmptyString(account.tokenSource);
  const apiProvider = nonEmptyString(account.apiProvider);
  const subscriptionType = nonEmptyString(account.subscriptionType);
  const email = nonEmptyString(account.email);
  const rawAuthSource = tokenSource ?? apiProvider ?? "unknown";

  if (tokenSource !== undefined && API_KEY_TOKEN_SOURCES.has(normalizeAuthToken(tokenSource))) {
    return { accountClass: "api-key-token", email, rawAuthSource };
  }
  if (apiProvider !== undefined && API_KEY_API_PROVIDERS.has(normalizeAuthToken(apiProvider))) {
    return { accountClass: "api-key-token", email, rawAuthSource };
  }
  if (subscriptionType !== undefined && apiProvider === "firstParty") {
    return { accountClass: "subscription", email, plan: planLabel(subscriptionType) };
  }
  return { accountClass: "unrecognized", email, rawAuthSource };
}

export interface ReadFallbackEmailDeps {
  readFile?: (path: string) => Promise<string>;
  home?: string;
}

export async function readFallbackEmail(
  configDir: string | undefined,
  deps: ReadFallbackEmailDeps = {},
): Promise<string | undefined> {
  const read = deps.readFile ?? ((path: string) => readFile(path, "utf8"));
  const dir = configDir !== undefined && configDir !== "" ? configDir : (deps.home ?? homedir());
  let raw: string;
  try {
    raw = await read(join(dir, ".claude.json"));
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const oauthAccount = (parsed as Record<string, unknown>).oauthAccount;
    if (typeof oauthAccount !== "object" || oauthAccount === null) return undefined;
    return nonEmptyString((oauthAccount as Record<string, unknown>).emailAddress);
  } catch {
    return undefined;
  }
}

function pendingPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  const next = async (): Promise<IteratorResult<SDKUserMessage>> => {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return { done: true, value: undefined };
  };
  return { [Symbol.asyncIterator]: () => ({ next }) };
}

const TIMED_OUT = Symbol("claude-cli-account-probe-timeout");

function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<T | typeof TIMED_OUT> {
  const expiry: Promise<typeof TIMED_OUT> = sleep(timeoutMs).then(() => TIMED_OUT);
  return Promise.race<T | typeof TIMED_OUT>([work, expiry]);
}

export interface ProbeClaudeAccountInput {
  runtime: ClaudeCliRuntime;
  baseEnv?: NodeJS.ProcessEnv;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ProbeClaudeAccountDeps {
  query?: typeof sdkQuery;
  sleep?: (ms: number) => Promise<void>;
  readFallbackEmail?: typeof readFallbackEmail;
}

async function accountFromQuery(active: Query): Promise<AccountInfo | null> {
  let account: AccountInfo | null = null;
  try {
    const initialization = await active.initializationResult();
    account = initialization.account ?? null;
  } catch {
    account = null;
  }
  try {
    const direct = await active.accountInfo();
    if (direct !== null && direct !== undefined) account = direct;
  } catch {
    return account;
  }
  return account;
}

async function probeOnce(
  input: ProbeClaudeAccountInput,
  deps: ProbeClaudeAccountDeps,
  sleep: (ms: number) => Promise<void>,
): Promise<AccountInfo | null | typeof TIMED_OUT> {
  const run = deps.query ?? sdkQuery;
  const abortController = new AbortController();
  const options = buildQueryOptions({
    runtime: input.runtime,
    baseEnv: input.baseEnv ?? process.env,
    model: input.model ?? ACCOUNT_PROBE_MODEL,
    allowedTools: [],
    mcpServers: {},
    persistSession: false,
    abortController,
    stderr: () => {},
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  });

  const active = run({ prompt: pendingPrompt(abortController.signal), options });
  try {
    return await withTimeout(
      accountFromQuery(active),
      input.timeoutMs ?? ACCOUNT_PROBE_TIMEOUT_MS,
      sleep,
    );
  } catch {
    return null;
  } finally {
    abortController.abort();
    try {
      await active.return(undefined);
    } catch {
      /* the CLI is already gone */
    }
  }
}

export async function probeClaudeAccount(
  input: ProbeClaudeAccountInput,
  deps: ProbeClaudeAccountDeps = {},
): Promise<ClaudeAccountProbeResult> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let account = await probeOnce(input, deps, sleep);
  if (account === TIMED_OUT) {
    await sleep(ACCOUNT_PROBE_RETRY_DELAY_MS);
    account = await probeOnce(input, deps, sleep);
  }
  if (account === TIMED_OUT) {
    return { verified: false, accountClass: "unrecognized", reason: "timeout" };
  }

  const classified = classifyAccountInfo(account);
  if (classified.accountClass === "unrecognized") {
    const isAbsent = account === null || account === undefined;
    return {
      verified: false,
      accountClass: "unrecognized",
      ...(isAbsent ? { reason: "no-account" as const } : {}),
      ...(classified.rawAuthSource === undefined
        ? {}
        : { rawAuthSource: classified.rawAuthSource }),
    };
  }

  const readEmail = deps.readFallbackEmail ?? readFallbackEmail;
  const email = classified.email ?? (await readEmail(input.runtime.configDir));

  return {
    verified: true,
    accountClass: classified.accountClass,
    ...(email === undefined ? {} : { email }),
    ...(classified.plan === undefined ? {} : { plan: classified.plan }),
    ...(classified.rawAuthSource === undefined ? {} : { rawAuthSource: classified.rawAuthSource }),
  };
}

export function claudeIdentityLine(result: ClaudeAccountProbeResult): string {
  if (result.accountClass === "api-key-token") return API_KEY_BILLING_IDENTITY_LINE;
  const { email, plan } = result;
  if (plan === undefined) return email === undefined ? "Signed in" : `Signed in as ${email}`;
  return email === undefined
    ? `Signed in - Claude ${plan} subscription`
    : `Signed in as ${email} - Claude ${plan} subscription`;
}

export function refusalForProbe(
  result: ClaudeAccountProbeResult,
  billing: ClaudeCliBilling,
): ClaudeCliConfigError | null {
  if (result.reason === "timeout") return probeTimeoutError();
  if (!result.verified) {
    if (result.accountClass === "unrecognized" && result.reason !== "no-account") {
      return unrecognizedAuthSourceError(result.rawAuthSource ?? "unknown");
    }
    return notSignedInError();
  }
  if (billing === "api-key") {
    return result.accountClass === "api-key-token" ? null : apiKeyUnapprovedError();
  }
  return result.accountClass === "subscription" ? null : apiKeyIdentityError();
}

export interface ClaudeCliReadiness {
  readonly binaryPath: string;
  readonly version: string;
  readonly identityLine: string;
  readonly accountClass: ClaudeAccountClass;
  readonly email?: string;
  readonly plan?: string;
}

export interface EnsureClaudeCliReadyInput {
  binaryPath?: string;
  configDir?: string;
  billing?: ClaudeCliBilling;
  baseEnv?: NodeJS.ProcessEnv;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface EnsureClaudeCliReadyDeps extends ProbeClaudeAccountDeps {
  resolveBinary?: typeof resolveClaudeBinary;
  probeVersion?: typeof probeVersion;
  probeAccount?: typeof probeClaudeAccount;
}

export async function ensureClaudeCliReady(
  input: EnsureClaudeCliReadyInput = {},
  deps: EnsureClaudeCliReadyDeps = {},
): Promise<ClaudeCliReadiness> {
  const billing = input.billing ?? "subscription";
  const baseEnv = input.baseEnv ?? process.env;
  const resolveBinary = deps.resolveBinary ?? resolveClaudeBinary;
  const readVersion = deps.probeVersion ?? probeVersion;
  const probeAccount = deps.probeAccount ?? probeClaudeAccount;

  const resolved = await resolveBinary({
    ...(input.binaryPath === undefined ? {} : { explicitPath: input.binaryPath }),
    env: baseEnv,
  });
  if (resolved === null) throw binaryMissingError(input.binaryPath ?? "claude");

  const runtime: ClaudeCliRuntime = {
    binaryPath: resolved,
    billing,
    ...(input.configDir === undefined ? {} : { configDir: input.configDir }),
  };

  const version = await readVersion(resolved, { runtime, baseEnv });
  assertVersionAtLeast(version, CLAUDE_CLI_VERSION_FLOOR);

  const result = await probeAccount(
    {
      runtime,
      baseEnv,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    deps,
  );

  const refusal = refusalForProbe(result, billing);
  if (refusal !== null) throw refusal;

  return {
    binaryPath: resolved,
    version,
    identityLine: claudeIdentityLine(result),
    accountClass: result.accountClass,
    ...(result.email === undefined ? {} : { email: result.email }),
    ...(result.plan === undefined ? {} : { plan: result.plan }),
  };
}
