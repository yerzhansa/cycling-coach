import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChatGptAuth,
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

  it("does not replace an unreadable existing profile path", async () => {
    const directory = await configDir();
    const path = join(directory, "auth-profiles.json");
    await mkdir(path, { recursive: true });
    await expect(writeChatGptProfile(directory, credentials())).rejects.toBeDefined();
    expect((await stat(path)).isDirectory()).toBe(true);
    await expect(hasChatGptProfile(directory)).resolves.toBe(false);
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
    await expect(timedOut.login()).resolves.toEqual({ status: "refused", reason: "timed-out" });

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
    await expect(cancelled.login()).resolves.toEqual({ status: "refused", reason: "cancelled" });

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
    await expect(exchange.login()).resolves.toEqual({
      status: "refused",
      reason: "exchange-failed",
    });
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
          options.onAuth({ url: "https://auth.openai.com/obviously-fake" });
          await vi.waitFor(() => expect(openExternal).toHaveBeenCalledOnce());
          return credentials();
        },
      },
    });
    await expect(auth.login()).resolves.toEqual({ status: "configured", runtimeReady: true });
    expect(applyRuntimeConfig).toHaveBeenCalledWith({
      llm: { provider: "openai-codex", model: "gpt-5.5" },
    });
    expect(order).toEqual(["browser", "storage", "runtime"]);
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: true });
  });

  it("restores configured runtime readiness from the current YAML", async () => {
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
    const first = auth.login();
    await expect(auth.login()).resolves.toEqual({
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
    await expect(callback.login()).resolves.toEqual({
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
    await expect(storage.login()).resolves.toEqual({
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
    await expect(runtime.login()).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });
  });

  it("reports a saved ChatGPT profile as inactive after an API-key provider is selected", async () => {
    const directory = await configDir();
    const auth = createChatGptAuth({
      configDir: directory,
      openExternal: async () => {},
      applyRuntimeConfig: async (request) => {
        await writeFile(
          join(directory, "config.yaml"),
          `llm:\n  provider: ${request.llm?.provider}\n  model: ${request.llm?.model}\n`,
        );
      },
      dependencies: { loginCodex: async () => credentials() },
    });
    await expect(auth.login()).resolves.toEqual({ status: "configured", runtimeReady: true });
    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: true });

    await writeFile(
      join(directory, "config.yaml"),
      "llm:\n  provider: openrouter\n  model: deepseek/deepseek-v4-flash\n",
    );

    await expect(auth.status()).resolves.toEqual({ state: "configured", runtimeReady: false });
  });
});
