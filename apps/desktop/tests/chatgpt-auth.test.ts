import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider, RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import {
  createChatGptAuth as createChatGptAuthSubject,
  hasChatGptProfile,
  writeChatGptProfile,
} from "../src/main/chatgpt-auth.js";

const roots: string[] = [];

async function configDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-chatgpt-auth-"));
  roots.push(root);
  return join(root, "config");
}

function credentials() {
  return {
    access: "obviously-fake-access",
    refresh: "obviously-fake-refresh",
    expires: 4_102_444_800_000,
    accountId: "obviously-fake-account",
  };
}

function selection(model = "gpt-5.5") {
  return {
    provider: "openai-codex" as const,
    model,
    endpoint: { mode: "automatic" as const },
  };
}

function runtimeSnapshot(
  provider: LlmProvider = "openai-codex",
  credentialConfigured = provider === "openai-codex",
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 2,
    llm: {
      provider,
      model: "custom-selected-model",
      credential_configured: credentialConfigured,
    },
    intervals: { athlete_id: "custom-athlete" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  };
}

function createChatGptAuth(
  options: Omit<Parameters<typeof createChatGptAuthSubject>[0], "getRuntimeConfig"> & {
    readonly getRuntimeConfig?: () => Promise<RuntimeConfigSnapshot>;
  },
) {
  return createChatGptAuthSubject({
    ...options,
    getRuntimeConfig: options.getRuntimeConfig ?? (async () => runtimeSnapshot()),
  });
}

function invalidUtf8ProfilesBytes(): Buffer {
  return Buffer.concat([
    Buffer.from('{"openai-codex":{"type":"oauth","access":"invalid-', "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('","refresh":"invalid-refresh","expires":4102444800000}}', "utf8"),
  ]);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop ChatGPT auth", () => {
  it("atomically merges the profile with mode 0600 and validates its shape", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    const path = join(directory, "auth-profiles.json");
    const first = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    first.other = { type: "oauth", marker: true };
    await writeFile(path, JSON.stringify(first));
    await chmod(path, 0o644);
    await writeChatGptProfile(directory, credentials());
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(stored.other).toEqual({ type: "oauth", marker: true });
    expect(stored["openai-codex"]).toMatchObject({
      type: "oauth",
      access: "obviously-fake-access",
      refresh: "obviously-fake-refresh",
      expires: 4_102_444_800_000,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(hasChatGptProfile(directory)).resolves.toBe(true);
  });

  it("preserves unrelated profile fields and the Desktop credential shape", async () => {
    const directory = await configDir();
    const path = join(directory, "auth-profiles.json");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        other: {
          type: "oauth",
          access: "obviously-fake-other-access",
          future: { generation: 1 },
        },
      }),
    );

    const write = writeChatGptProfile(directory, {
      ...credentials(),
      accountId: "",
      email: "synthetic@example.invalid",
    });

    expect(write).toBeInstanceOf(Promise);
    await write;
    const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(stored.other).toEqual({
      type: "oauth",
      access: "obviously-fake-other-access",
      future: { generation: 1 },
    });
    expect(stored["openai-codex"]).toEqual({
      type: "oauth",
      access: "obviously-fake-access",
      refresh: "obviously-fake-refresh",
      expires: 4_102_444_800_000,
      email: "synthetic@example.invalid",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("treats absent, corrupt, and invalid profiles as absent", async () => {
    const directory = await configDir();
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    await writeChatGptProfile(directory, credentials());
    await writeFile(join(directory, "auth-profiles.json"), "{");
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    await writeFile(
      join(directory, "auth-profiles.json"),
      JSON.stringify({ "openai-codex": { type: "oauth" } }),
    );
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
  });

  it("reports invalid UTF-8 profile bytes as absent before login", async () => {
    const directory = await configDir();
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "auth-profiles.json"), invalidUtf8ProfilesBytes());
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      getRuntimeConfig: async () => runtimeSnapshot("openai-codex", false),
    });

    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    await expect(auth.status()).resolves.toEqual({ state: "absent", runtimeReady: false });
  });

  it("reports a valid target with an invalid sibling profile as absent", async () => {
    const directory = await configDir();
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "auth-profiles.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "obviously-fake-access",
          refresh: "obviously-fake-refresh",
          expires: 4_102_444_800_000,
        },
        invalidSibling: "not-a-profile-map",
      }),
    );
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      getRuntimeConfig: async () => runtimeSnapshot("openai-codex", false),
    });

    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    await expect(auth.status()).resolves.toEqual({ state: "absent", runtimeReady: false });
  });

  it("completes login by quarantining invalid UTF-8 profile bytes", async () => {
    const directory = await configDir();
    const path = join(directory, "auth-profiles.json");
    const originalBytes = invalidUtf8ProfilesBytes();
    await mkdir(directory, { recursive: true });
    await writeFile(path, originalBytes, { mode: 0o600 });
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: { loginCodex: async () => credentials() },
    });

    await expect(auth.login(selection())).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    expect(await readFile(`${path}.corrupt`)).toEqual(originalBytes);
    expect((await stat(`${path}.corrupt`)).mode & 0o777).toBe(0o600);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(hasChatGptProfile(directory)).resolves.toBe(true);
  });

  it("does not replace an unreadable existing profile path", async () => {
    const directory = await configDir();
    const path = join(directory, "auth-profiles.json");
    await mkdir(path, { recursive: true });
    await expect(writeChatGptProfile(directory, credentials())).rejects.toBeDefined();
    expect((await stat(path)).isDirectory()).toBe(true);
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: { loginCodex: async () => credentials() },
    });
    await expect(auth.login(selection())).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });
    expect((await stat(path)).isDirectory()).toBe(true);
  });

  it("maps timeout, browser cancellation, and exchange failures", async () => {
    const directory = await configDir();
    const timedOut = createChatGptAuth({
      configDir: directory,
      timeoutMs: 1,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async (options) =>
          await new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          }),
      },
    });
    await expect(timedOut.login(selection())).resolves.toEqual({
      status: "refused",
      reason: "timed-out",
    });

    const cancelled = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {
        throw new TypeError();
      },
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async (options) => {
          options.onAuth({ url: "https://auth.openai.com/obviously-fake" });
          return await new Promise((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
              once: true,
            });
          });
        },
      },
    });
    await expect(cancelled.login(selection())).resolves.toEqual({
      status: "refused",
      reason: "cancelled",
    });

    const exchange = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async () => {
          throw new TypeError();
        },
      },
    });
    await expect(exchange.login(selection())).resolves.toEqual({
      status: "refused",
      reason: "exchange-failed",
    });
  });

  it("does not open or abort the browser flow when the callback listener is unavailable", async () => {
    const directory = await configDir();
    const openExternal = vi.fn(async () => {});
    let reachedPrompt = false;
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal,
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async (options) => {
          options.onAuth({
            url: "https://auth.openai.com/obviously-fake",
            callbackAvailable: false,
          });
          expect(options.signal?.aborted).toBe(false);
          reachedPrompt = true;
          await options.onPrompt({ message: "obviously-fake" });
          return credentials();
        },
      },
    });

    await expect(auth.login(selection())).resolves.toEqual({
      status: "refused",
      reason: "callback-unavailable",
    });
    expect(reachedPrompt).toBe(true);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("treats missing callback availability as available for compatibility", async () => {
    const directory = await configDir();
    const openExternal = vi.fn(async () => {});
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal,
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async (options) => {
          options.onAuth({ url: "https://auth.openai.com/obviously-fake" });
          await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
          return credentials();
        },
      },
    });

    await expect(auth.login(selection())).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it("opens the browser, stores first, and applies a keyless Codex request", async () => {
    const directory = await configDir();
    const order: string[] = [];
    const openExternal = vi.fn(async () => {
      order.push("browser");
    });
    const writeProfile = vi.fn(async () => {
      order.push("storage");
      await writeChatGptProfile(directory, credentials());
    });
    const applyRuntimeConfig = vi.fn(async () => {
      order.push("runtime");
      await writeFile(
        join(directory, "config.yaml"),
        "llm:\n  provider: openai-codex\n  model: gpt-5.5\n",
      );
    });
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal,
      applyRuntimeConfig,
      dependencies: {
        writeProfile,
        loginCodex: async (options) => {
          expect(options.signal).toBeInstanceOf(AbortSignal);
          options.onAuth({
            url: "https://auth.openai.com/obviously-fake",
            callbackAvailable: true,
          });
          await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
          return credentials();
        },
      },
    });
    await expect(auth.login(selection())).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    expect(applyRuntimeConfig).toHaveBeenCalledWith({
      llm: { provider: "openai-codex", model: "gpt-5.5" },
    });
    expect(order).toEqual(["browser", "storage", "runtime"]);
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: true });
  });

  it("activates a stored profile with the selected model without reauthenticating", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    const applyRuntimeConfig = vi.fn(async () => {});
    const loginCodex = vi.fn(async () => credentials());
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig,
      dependencies: { loginCodex },
    });

    await expect(auth.activate(selection("athlete-custom-model"))).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    expect(applyRuntimeConfig).toHaveBeenCalledWith({
      llm: { provider: "openai-codex", model: "athlete-custom-model" },
    });
    expect(loginCodex).not.toHaveBeenCalled();
  });

  it("returns fixed stored-profile activation refusals", async () => {
    const directory = await configDir();
    const absent = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
    });
    await expect(absent.activate(selection())).resolves.toEqual({
      status: "refused",
      reason: "credential-required",
    });
    await expect(
      absent.activate({
        provider: "anthropic",
        model: "model",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "invalid-input" });

    await writeChatGptProfile(directory, credentials());
    const unavailable = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {
        throw new Error("private runtime detail");
      },
    });
    await expect(unavailable.activate(selection())).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });
  });

  it("restores configured runtime readiness from the daemon snapshot", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    await writeFile(
      join(directory, "config.yaml"),
      "llm:\n  provider: openai-codex\n  model: gpt-5.5\n",
    );
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
    });
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: true });
  });

  it("reports a valid active custom profile from the daemon without a default local profile", async () => {
    const directory = await configDir();
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      getRuntimeConfig: async () => runtimeSnapshot("openai-codex", true),
    });

    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: true });
  });

  it("falls back to local default-profile status when the daemon read is unavailable", async () => {
    const directory = await configDir();
    await writeChatGptProfile(directory, credentials());
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      getRuntimeConfig: async () => {
        throw new TypeError("synthetic daemon unavailable");
      },
    });

    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: false });
  });

  it("refuses concurrent login and maps callback, storage, and runtime failures", async () => {
    const directory = await configDir();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async () => {
          await gate;
          return credentials();
        },
      },
    });
    const first = auth.login(selection());
    await expect(auth.login(selection())).resolves.toEqual({
      status: "refused",
      reason: "already-in-progress",
    });
    release();
    await expect(first).resolves.toEqual({ status: "configured", runtimeReady: true });

    const callback = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async (options) => {
          await options.onPrompt({ message: "obviously-fake" });
          return credentials();
        },
      },
    });
    await expect(callback.login(selection())).resolves.toEqual({
      status: "refused",
      reason: "callback-unavailable",
    });

    const storage = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {},
      dependencies: {
        loginCodex: async () => credentials(),
        writeProfile: async () => {
          throw new TypeError();
        },
      },
    });
    await expect(storage.login(selection())).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });

    const runtime = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async () => {
        throw new TypeError();
      },
      dependencies: { loginCodex: async () => credentials() },
    });
    await expect(runtime.login(selection())).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });
  });

  it("reports a saved ChatGPT profile as inactive after an API-key provider is selected", async () => {
    const directory = await configDir();
    let provider: LlmProvider = "anthropic";
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async (request) => {
        provider = request.llm?.provider ?? provider;
        await writeFile(
          join(directory, "config.yaml"),
          `llm:\n  provider: ${request.llm?.provider}\n  model: ${request.llm?.model}\n`,
        );
      },
      getRuntimeConfig: async () => runtimeSnapshot(provider),
      dependencies: { loginCodex: async () => credentials() },
    });
    await expect(auth.login(selection())).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: true });

    await writeFile(
      join(directory, "config.yaml"),
      "llm:\n  provider: openrouter\n  model: deepseek/deepseek-v4-flash\n",
    );
    provider = "openrouter";

    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: false });
  });
});
