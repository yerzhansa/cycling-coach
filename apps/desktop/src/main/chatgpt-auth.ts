import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loginCodex, type CodexCredentials, type CodexLoginOptions } from "@enduragent/core";
import type { ConfigureRuntimeRpcParams } from "@enduragent/coach-contract";
import { parse as parseYaml } from "yaml";

export const CHATGPT_PROFILE_NAME = "openai-codex" as const;
export const CHATGPT_MODEL = "gpt-5.5" as const;
export const CHATGPT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export type ChatGptLoginRefusalReason =
  | "already-in-progress"
  | "callback-unavailable"
  | "timed-out"
  | "cancelled"
  | "exchange-failed"
  | "storage-failed"
  | "runtime-unavailable";

export interface ChatGptStatus {
  readonly state: "configured" | "absent";
  readonly runtimeReady: boolean;
}

export type ChatGptLoginResult =
  | { readonly status: "configured"; readonly runtimeReady: true }
  | { readonly status: "refused"; readonly reason: ChatGptLoginRefusalReason };

export interface ChatGptAuthController {
  status(): Promise<ChatGptStatus>;
  login(): Promise<ChatGptLoginResult>;
}

interface ChatGptAuthDependencies {
  readonly loginCodex?: (options: CodexLoginOptions) => Promise<CodexCredentials>;
  readonly writeProfile?: (configDir: string, credentials: CodexCredentials) => Promise<void>;
}

interface CreateChatGptAuthOptions {
  readonly configDir: string;
  readonly applyRuntimeConfig: (request: ConfigureRuntimeRpcParams) => Promise<void>;
  readonly openExternal: (url: string) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly dependencies?: ChatGptAuthDependencies;
}

class ChatGptAuthFlowError extends Error {
  constructor(readonly reason: "callback-unavailable" | "cancelled") {
    super(reason);
    this.name = "ChatGptAuthFlowError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validProfile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    value.access.length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.length > 0 &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires) &&
    (value.accountId === undefined || typeof value.accountId === "string") &&
    (value.email === undefined || typeof value.email === "string")
  );
}

async function readProfiles(configDir: string): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await readFile(join(configDir, "auth-profiles.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const parsed = JSON.parse(contents) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function hasChatGptProfile(configDir: string): Promise<boolean> {
  try {
    return validProfile((await readProfiles(configDir))[CHATGPT_PROFILE_NAME]);
  } catch {
    return false;
  }
}

export async function writeChatGptProfile(
  configDir: string,
  credentials: CodexCredentials,
): Promise<void> {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const path = join(configDir, "auth-profiles.json");
  const temporaryPath = join(configDir, `.auth-profiles.${randomUUID()}.tmp`);
  const profiles = await readProfiles(configDir);
  profiles[CHATGPT_PROFILE_NAME] = {
    type: "oauth",
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    ...(credentials.accountId.length > 0 ? { accountId: credentials.accountId } : {}),
    ...(credentials.email !== undefined ? { email: credentials.email } : {}),
  };
  try {
    await writeFile(temporaryPath, JSON.stringify(profiles, null, 2), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function configuredRuntime(configDir: string): Promise<boolean> {
  try {
    const parsed = parseYaml(await readFile(join(configDir, "config.yaml"), "utf8")) as unknown;
    return isRecord(parsed) && isRecord(parsed.llm) && parsed.llm.provider === CHATGPT_PROFILE_NAME;
  } catch {
    return false;
  }
}

function classifyLoginFailure(
  error: unknown,
  timeoutSignal: AbortSignal,
  sessionSignal: AbortSignal | undefined,
): ChatGptLoginRefusalReason {
  if (error instanceof ChatGptAuthFlowError) return error.reason;
  if (timeoutSignal.aborted) return "timed-out";
  if (sessionSignal?.aborted) return "cancelled";
  if (isRecord(error) && error.name === "AbortError") return "cancelled";
  return "exchange-failed";
}

export function createChatGptAuth(options: CreateChatGptAuthOptions): ChatGptAuthController {
  const runLogin = options.dependencies?.loginCodex ?? loginCodex;
  const storeProfile = options.dependencies?.writeProfile ?? writeChatGptProfile;
  let runtimeReadyThisSession = false;
  let activeLogin: Promise<ChatGptLoginResult> | undefined;

  const performLogin = async (): Promise<ChatGptLoginResult> => {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? CHATGPT_LOGIN_TIMEOUT_MS);
    const browserController = new AbortController();
    const signals = [timeoutSignal, browserController.signal];
    if (options.signal !== undefined) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    let credentials: CodexCredentials;
    try {
      credentials = await runLogin({
        originator: "enduragent-desktop",
        signal,
        onAuth: ({ url }) => {
          void options.openExternal(url).catch(() => {
            browserController.abort(new ChatGptAuthFlowError("cancelled"));
          });
        },
        onPrompt: async () => {
          throw new ChatGptAuthFlowError("callback-unavailable");
        },
      });
    } catch (error) {
      return {
        status: "refused",
        reason: classifyLoginFailure(error, timeoutSignal, options.signal),
      };
    }
    try {
      await storeProfile(options.configDir, credentials);
    } catch {
      return { status: "refused", reason: "storage-failed" };
    }
    try {
      await options.applyRuntimeConfig({
        llm: { provider: CHATGPT_PROFILE_NAME, model: CHATGPT_MODEL },
      });
    } catch {
      return { status: "refused", reason: "runtime-unavailable" };
    }
    runtimeReadyThisSession = true;
    return { status: "configured", runtimeReady: true };
  };

  return {
    async status() {
      const configured = await hasChatGptProfile(options.configDir);
      return {
        state: configured ? "configured" : "absent",
        runtimeReady:
          configured && (runtimeReadyThisSession || (await configuredRuntime(options.configDir))),
      };
    },
    async login() {
      if (activeLogin !== undefined) {
        return { status: "refused", reason: "already-in-progress" };
      }
      const pending = performLogin();
      activeLogin = pending;
      try {
        return await pending;
      } finally {
        if (activeLogin === pending) activeLogin = undefined;
      }
    },
  };
}
