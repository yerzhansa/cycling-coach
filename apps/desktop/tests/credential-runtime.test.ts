import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigureRuntimeRpcParams, LlmProvider } from "@enduragent/coach-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialRuntimeApplication,
  readSelectedLlmProvider,
  type CredentialRuntimeApplication,
} from "../src/main/credential-runtime.js";
import {
  createCredentialVault,
  type CredentialEncryptionPort,
  type CredentialVault,
  type DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import {
  DESKTOP_CREDENTIAL_STATUS_CHANNEL,
  registerOnboardingIpc,
  runtimeConfigurationForCredential,
} from "../src/main/onboarding-ipc.js";

const roots: string[] = [];

function encryption(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString(),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeDaemon(initialProvider: LlmProvider) {
  let persistedProvider = initialProvider;
  let activeProvider = initialProvider;
  let intervalsApplications = 0;
  const modelApplications: LlmProvider[] = [];

  return {
    launch(): CredentialRuntimeApplication {
      activeProvider = persistedProvider;
      return createCredentialRuntimeApplication({
        selectedLlmProvider: async () => persistedProvider,
        async configureRuntime(request: ConfigureRuntimeRpcParams) {
          if (request.llm !== undefined) {
            activeProvider = request.llm.provider;
            persistedProvider = request.llm.provider;
            modelApplications.push(request.llm.provider);
          }
          if (request.intervals !== undefined) intervalsApplications += 1;
        },
      });
    },
    activeProvider: () => activeProvider,
    persistedProvider: () => persistedProvider,
    intervalsApplications: () => intervalsApplications,
    modelApplications: () => [...modelApplications],
    clearModelApplications: () => modelApplications.splice(0),
  };
}

function fakeVault(initialRuntime: CredentialRuntimeApplication) {
  const slots = new Set<DesktopCredentialSlot>();
  let runtime = initialRuntime;
  const port: CredentialVault = {
    async writeCredential(input) {
      slots.add(input.slot);
      await runtime.applyExplicit(runtimeConfigurationForCredential(input.slot, randomUUID()));
      return { slot: input.slot, status: "configured", runtimeReady: true };
    },
    async credentialStatuses() {
      return [...slots].map((slot) => ({
        slot,
        state: "configured" as const,
        runtimeState: "stored-inactive" as const,
      }));
    },
    async reapplyConfigured() {
      for (const slot of slots) {
        await runtime.reapplyStoredCredential(slot, randomUUID(), [...slots]);
      }
    },
    async retryFailed() {},
  };

  return {
    port,
    use(nextRuntime: CredentialRuntimeApplication) {
      runtime = nextRuntime;
    },
  };
}

async function pollCredentialStatuses(vault: CredentialVault): Promise<void> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const dispose = registerOnboardingIpc({
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      },
    } as never,
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    window: {} as never,
    vault,
    chatGptAuth: {
      status: async () => ({ state: "absent", runtimeReady: false }),
      login: async () => ({ status: "refused", reason: "cancelled" }),
    },
    isTrusted: () => true,
  });
  try {
    await handlers.get(DESKTOP_CREDENTIAL_STATUS_CHANNEL)!({});
  } finally {
    dispose();
  }
}

describe("desktop credential runtime precedence", () => {
  it("self-heals a stored provider after the first-run seed outlives a failed apply", async () => {
    const directory = await mkdtemp(join(tmpdir(), "enduragent-credential-runtime-"));
    roots.push(directory);
    const configDir = join(directory, "config");
    const vaultRoot = join(directory, "credentials-v1");
    await mkdir(configDir);
    await writeFile(
      join(configDir, "config.yaml"),
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-6\n",
    );
    let runtimeAvailable = false;
    let activeProvider: LlmProvider = "anthropic";
    const launchRuntime = (): CredentialRuntimeApplication =>
      createCredentialRuntimeApplication({
        selectedLlmProvider: (storedCredentialSlots) =>
          readSelectedLlmProvider(configDir, {
            chatGptProfilePresent: false,
            storedCredentialSlots,
          }),
        async configureRuntime(request) {
          if (!runtimeAvailable) throw new TypeError();
          if (request.llm === undefined) return;
          activeProvider = request.llm.provider;
          await writeFile(
            join(configDir, "config.yaml"),
            `llm:\n  provider: ${request.llm.provider}\n  model: ${request.llm.model}\n`,
          );
        },
      });
    let runtime = launchRuntime();
    const launchVault = () =>
      createCredentialVault({
        root: vaultRoot,
        encryption: encryption(),
        applyCredential: (slot, value) =>
          runtime.applyExplicit(runtimeConfigurationForCredential(slot, value)),
        reapplyCredential: runtime.reapplyStoredCredential,
      });
    let vault = launchVault();

    await expect(
      vault.writeCredential({ slot: "openrouter", value: randomUUID() }),
    ).resolves.toMatchObject({ status: "refused", reason: "runtime-unavailable" });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "openrouter",
      state: "configured",
      runtimeState: "failed",
    });

    runtimeAvailable = true;
    runtime = launchRuntime();
    vault = launchVault();
    await vault.reapplyConfigured();

    expect(activeProvider).toBe("openrouter");
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "openrouter",
      state: "configured",
      runtimeState: "active",
    });
  });

  it("keeps a dormant API credential inactive across relaunch when a profile corroborates ChatGPT", async () => {
    const directory = await mkdtemp(join(tmpdir(), "enduragent-credential-runtime-"));
    roots.push(directory);
    const configDir = join(directory, "config");
    const vaultRoot = join(directory, "credentials-v1");
    await mkdir(configDir);
    const initialVault = createCredentialVault({
      root: vaultRoot,
      encryption: encryption(),
      applyCredential: async () => {},
    });
    await expect(
      initialVault.writeCredential({ slot: "anthropic", value: randomUUID() }),
    ).resolves.toMatchObject({ status: "configured" });
    await writeFile(
      join(configDir, "config.yaml"),
      "llm:\n  provider: openai-codex\n  model: gpt-5.5\n",
    );
    const configureRuntime = vi.fn(async () => {});
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: (storedCredentialSlots) =>
        readSelectedLlmProvider(configDir, {
          chatGptProfilePresent: true,
          storedCredentialSlots,
        }),
      configureRuntime,
    });
    const relaunchedVault = createCredentialVault({
      root: vaultRoot,
      encryption: encryption(),
      applyCredential: (slot, value) =>
        runtime.applyExplicit(runtimeConfigurationForCredential(slot, value)),
      reapplyCredential: runtime.reapplyStoredCredential,
    });

    await relaunchedVault.reapplyConfigured();

    expect(configureRuntime).not.toHaveBeenCalled();
    await expect(relaunchedVault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    });
  });

  it("requires a profile or stored credential to corroborate the recorded provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "enduragent-credential-runtime-"));
    roots.push(directory);
    await writeFile(
      join(directory, "config.yaml"),
      "llm:\n  provider: openai-codex\n  model: gpt-5.5\n",
    );

    await expect(
      readSelectedLlmProvider(directory, {
        chatGptProfilePresent: true,
        storedCredentialSlots: [],
      }),
    ).resolves.toBe("openai-codex");
    await expect(
      readSelectedLlmProvider(directory, {
        chatGptProfilePresent: false,
        storedCredentialSlots: [],
      }),
    ).resolves.toBeUndefined();

    await writeFile(
      join(directory, "config.yaml"),
      "llm:\n  provider: anthropic\n  model: claude-sonnet-4-6\n",
    );
    await expect(
      readSelectedLlmProvider(directory, {
        chatGptProfilePresent: false,
        storedCredentialSlots: ["anthropic"],
      }),
    ).resolves.toBe("anthropic");
    await expect(
      readSelectedLlmProvider(directory, {
        chatGptProfilePresent: false,
        storedCredentialSlots: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("serializes passive replay before a later explicit provider selection", async () => {
    let selectedProvider: LlmProvider = "anthropic";
    let releaseReplay!: () => void;
    let replayStarted!: () => void;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const replayStart = new Promise<void>((resolve) => {
      replayStarted = resolve;
    });
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => selectedProvider,
      async configureRuntime(request) {
        if (request.llm?.provider === "anthropic") {
          replayStarted();
          await replayGate;
        }
        if (request.llm !== undefined) selectedProvider = request.llm.provider;
      },
    });
    const replay = runtime.reapplyStoredCredential("anthropic", randomUUID(), ["anthropic"]);
    await replayStart;
    const explicit = runtime.applyExplicit({
      llm: { provider: "openai-codex", model: "gpt-5.5" },
    });

    releaseReplay();
    await Promise.all([replay, explicit]);

    expect(selectedProvider).toBe("openai-codex");
  });

  it("keeps a later ChatGPT selection when stored model credentials reapply at boot", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });
    await runtime.applyExplicit({ llm: { provider: "openai-codex", model: "gpt-5.5" } });

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await vault.port.reapplyConfigured();

    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.persistedProvider()).toBe("openai-codex");
    expect(daemon.modelApplications()).toEqual([]);
  });

  it("keeps a later ChatGPT selection when the wizard polls credential status", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });
    await runtime.applyExplicit({ llm: { provider: "openai-codex", model: "gpt-5.5" } });

    daemon.clearModelApplications();
    await pollCredentialStatuses(vault.port);
    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.modelApplications()).toEqual([]);

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await pollCredentialStatuses(vault.port);
    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.modelApplications()).toEqual([]);
  });

  it("reapplies an unrelated service credential without changing the ChatGPT selection", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });
    await runtime.applyExplicit({ llm: { provider: "openai-codex", model: "gpt-5.5" } });

    daemon.clearModelApplications();
    await vault.port.writeCredential({ slot: "intervals-icu", value: randomUUID() });
    await pollCredentialStatuses(vault.port);
    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.intervalsApplications()).toBe(2);
    expect(daemon.modelApplications()).toEqual([]);

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await vault.port.reapplyConfigured();
    expect(daemon.activeProvider()).toBe("openai-codex");
    expect(daemon.intervalsApplications()).toBe(3);
    expect(daemon.modelApplications()).toEqual([]);
  });

  it("reapplies the selected API-key provider when there is no ChatGPT selection", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await vault.port.reapplyConfigured();

    expect(daemon.activeProvider()).toBe("anthropic");
    expect(daemon.persistedProvider()).toBe("anthropic");
    expect(daemon.modelApplications()).toEqual(["anthropic"]);
  });

  it("self-heals an unrecorded explicit selection after runtime application recovers", async () => {
    let selectedProvider: LlmProvider | undefined;
    let runtimeAvailable = false;
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => selectedProvider,
      async configureRuntime(request) {
        if (!runtimeAvailable) throw new TypeError();
        if (request.llm !== undefined) selectedProvider = request.llm.provider;
      },
    });
    const slot = "anthropic" as const;

    await expect(
      runtime.applyExplicit(runtimeConfigurationForCredential(slot, randomUUID())),
    ).rejects.toBeInstanceOf(TypeError);
    runtimeAvailable = true;

    await expect(runtime.reapplyStoredCredential(slot, randomUUID(), [slot])).resolves.toBe(
      "active",
    );
    expect(selectedProvider).toBe(slot);
  });

  it("self-heals a failed stored key after that slot becomes the recorded selection", async () => {
    let selectedProvider: LlmProvider | undefined;
    let runtimeAvailable = false;
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => selectedProvider,
      async configureRuntime(request) {
        if (!runtimeAvailable) throw new TypeError();
        if (request.llm !== undefined) selectedProvider = request.llm.provider;
      },
    });
    const slot = "anthropic" as const;

    await expect(
      runtime.applyExplicit(runtimeConfigurationForCredential(slot, randomUUID())),
    ).rejects.toBeInstanceOf(TypeError);
    selectedProvider = slot;
    runtimeAvailable = true;

    await expect(runtime.reapplyStoredCredential(slot, randomUUID(), [slot])).resolves.toBe(
      "active",
    );
    expect(selectedProvider).toBe(slot);
  });

  it("keeps self-heal inert when another provider is the recorded selection", async () => {
    const configureRuntime = vi.fn(async () => {});
    const runtime = createCredentialRuntimeApplication({
      selectedLlmProvider: async () => "openai-codex",
      configureRuntime,
    });

    await expect(
      runtime.reapplyStoredCredential("anthropic", randomUUID(), ["anthropic"]),
    ).resolves.toBe("stored-inactive");
    expect(configureRuntime).not.toHaveBeenCalled();
  });

  it("persists a deliberate switch from ChatGPT back to an API-key provider", async () => {
    const daemon = fakeDaemon("anthropic");
    let runtime = daemon.launch();
    const vault = fakeVault(runtime);
    await vault.port.writeCredential({ slot: "anthropic", value: randomUUID() });
    await runtime.applyExplicit({ llm: { provider: "openai-codex", model: "gpt-5.5" } });

    await vault.port.writeCredential({ slot: "openrouter", value: randomUUID() });
    daemon.clearModelApplications();
    await pollCredentialStatuses(vault.port);
    expect(daemon.activeProvider()).toBe("openrouter");
    expect(daemon.persistedProvider()).toBe("openrouter");
    expect(daemon.modelApplications()).toEqual(["openrouter"]);

    runtime = daemon.launch();
    vault.use(runtime);
    daemon.clearModelApplications();
    await vault.port.reapplyConfigured();
    expect(daemon.activeProvider()).toBe("openrouter");
    expect(daemon.persistedProvider()).toBe("openrouter");
    expect(daemon.modelApplications()).toEqual(["openrouter"]);
  });
});
