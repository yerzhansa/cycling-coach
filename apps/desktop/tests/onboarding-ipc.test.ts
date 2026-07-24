import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL,
  DESKTOP_CHATGPT_LOGIN_CHANNEL,
  DESKTOP_CHATGPT_STATUS_CHANNEL,
  DESKTOP_CREDENTIAL_RETRY_CHANNEL,
  DESKTOP_CREDENTIAL_DELETE_CHANNEL,
  DESKTOP_CREDENTIAL_STATUS_CHANNEL,
  DESKTOP_CREDENTIAL_WRITE_CHANNEL,
  DESKTOP_LLM_CONFIGURATION_CHANNEL,
  DESKTOP_LLM_SELECTION_APPLY_CHANNEL,
  registerOnboardingIpc,
  runtimeConfigurationForCredential,
} from "../src/main/onboarding-ipc.js";
import { runtimeConfigurationForExistingSelection } from "../src/main/llm-selection.js";
import type { CredentialVault } from "../src/main/credential-vault.js";

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type OwnershipCheck = (
  value: string,
) => Promise<"unowned" | "matched" | "mismatch" | "unresolved" | "store-unavailable">;

function harness(
  checkIntervalsCredentialOwner: OwnershipCheck = vi.fn(async () => "unresolved" as const),
) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const vault: CredentialVault = {
    writeCredential: vi.fn(async (input, behavior) => ({
      slot: input.slot,
      status: "configured" as const,
      runtimeReady: behavior?.activate !== false,
    })),
    applyLlmSelection: vi.fn(async () => ({
      status: "configured" as const,
      runtimeReady: true as const,
    })),
    credentialStatuses: vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState: "active" as const,
      },
    ]),
    deleteCredential: vi.fn(async (slot) => ({
      slot,
      status: "deleted" as const,
      cleanupPending: false,
    })),
    reapplyConfigured: vi.fn(async () => {}),
    retryFailed: vi.fn(async () => {}),
  };
  const dialog = {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: ["/synthetic/ride.fit", "/synthetic/ride.txt", "relative.tcx"],
    })),
  };
  const chatGptAuth = {
    status: vi.fn(async () => ({ state: "configured" as const, runtimeReady: true })),
    login: vi.fn(async () => ({ status: "configured" as const, runtimeReady: true as const })),
    activate: vi.fn(async () => ({ status: "configured" as const, runtimeReady: true as const })),
    deleteCredential: vi.fn(async () => ({
      status: "deleted" as const,
      cleanupPending: false as const,
    })),
  };
  const getRuntimeConfig = vi.fn(async () => ({
    schemaVersion: 3 as const,
    llm: {
      provider: "anthropic" as const,
      model: "athlete-selected-model",
      credential_configured: true,
    },
    intervals: {
      athlete_id: "synthetic-athlete",
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
    },
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
  }));
  const applyExistingLlmSelection = vi.fn(async () => false);
  const trustedEvent = {} as IpcMainInvokeEvent;
  const dispose = registerOnboardingIpc({
    ipcMain: ipcMain as never,
    dialog,
    window: {} as never,
    vault,
    chatGptAuth,
    getRuntimeConfig,
    applyExistingLlmSelection,
    isTrusted: (event) => event === trustedEvent,
    checkIntervalsCredentialOwner,
  });
  const invoke = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
    handlers.get(channel)!(event, ...args);
  return {
    handlers,
    ipcMain,
    vault,
    chatGptAuth,
    getRuntimeConfig,
    applyExistingLlmSelection,
    dialog,
    checkIntervalsCredentialOwner,
    trustedEvent,
    dispose,
    invoke,
  };
}

describe("desktop onboarding IPC", () => {
  it("refuses an intervals.icu credential for a different training account", async () => {
    const subject = harness(vi.fn(async () => "mismatch" as const));

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "intervals-icu",
        value: "synthetic",
      }),
    ).resolves.toEqual({
      slot: "intervals-icu",
      status: "refused",
      reason: "training-account-mismatch",
    });
    expect(subject.checkIntervalsCredentialOwner).toHaveBeenCalledWith("synthetic");
    expect(subject.vault.writeCredential).not.toHaveBeenCalled();
  });

  it.each([
    ["the same training account", "matched"],
    ["a readable ownerless store", "unowned"],
    ["an unresolved identity", "unresolved"],
    ["an unavailable store", "store-unavailable"],
  ] as const)("saves an intervals.icu credential for %s", async (_case, outcome) => {
    const subject = harness(vi.fn(async () => outcome));

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "intervals-icu",
        value: "synthetic",
      }),
    ).resolves.toEqual({
      slot: "intervals-icu",
      status: "configured",
      runtimeReady: true,
    });
    expect(subject.vault.writeCredential).toHaveBeenCalledOnce();
  });

  it("saves an intervals.icu credential when the convenience check fails", async () => {
    const subject = harness(
      vi.fn(async () => {
        throw new Error("check unavailable");
      }),
    );

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "intervals-icu",
        value: "synthetic",
      }),
    ).resolves.toMatchObject({ status: "configured" });
    expect(subject.vault.writeCredential).toHaveBeenCalledOnce();
  });

  it("maps each credential slot to the landed runtime request", () => {
    expect(runtimeConfigurationForCredential("anthropic", "synthetic")).toEqual({
      llm: { provider: "anthropic", api_key: "synthetic" },
    });
    expect(runtimeConfigurationForCredential("openrouter", "synthetic")).toEqual({
      llm: {
        provider: "openrouter",
        api_key: "synthetic",
      },
    });
    expect(runtimeConfigurationForCredential("intervals-icu", "synthetic")).toEqual({
      intervals: { api_key: "synthetic" },
    });
    expect(
      runtimeConfigurationForCredential("openrouter", "synthetic", {
        provider: "openrouter",
        model: "athlete-model",
        endpoint: { mode: "automatic" },
      }),
    ).toEqual({
      llm: {
        provider: "openrouter",
        model: "athlete-model",
        api_key: "synthetic",
      },
    });
    expect(
      runtimeConfigurationForCredential("openrouter", "synthetic", {
        provider: "openrouter",
        model: "athlete-model",
        endpoint: { mode: "default" },
      }),
    ).toEqual({
      llm: {
        provider: "openrouter",
        model: "athlete-model",
        api_key: "synthetic",
        base_url: null,
      },
    });
    expect(
      runtimeConfigurationForCredential("openrouter", "synthetic", {
        provider: "openrouter",
        model: "athlete-model",
        endpoint: { mode: "custom", value: "https://models.example.invalid/v1" },
      }),
    ).toEqual({
      llm: {
        provider: "openrouter",
        model: "athlete-model",
        api_key: "synthetic",
        base_url: "https://models.example.invalid/v1",
      },
    });
    expect(() =>
      runtimeConfigurationForCredential("anthropic", "synthetic", {
        provider: "anthropic",
        model: "athlete-model",
        endpoint: { mode: "default" },
      }),
    ).toThrow(TypeError);
    expect(
      runtimeConfigurationForExistingSelection({
        provider: "openai-codex",
        model: "athlete-chat-model",
        endpoint: { mode: "automatic" },
      }),
    ).toEqual({
      llm: { model: "athlete-chat-model" },
    });
    expect(
      runtimeConfigurationForExistingSelection({
        provider: "openrouter",
        model: "athlete-model",
        endpoint: { mode: "default" },
      }),
    ).toEqual({
      llm: { model: "athlete-model", base_url: null },
    });
  });

  it("registers only semantic onboarding channels and returns metadata", async () => {
    const subject = harness();
    expect([...subject.handlers.keys()].sort()).toEqual(
      [
        DESKTOP_CREDENTIAL_STATUS_CHANNEL,
        DESKTOP_CREDENTIAL_RETRY_CHANNEL,
        DESKTOP_CREDENTIAL_WRITE_CHANNEL,
        DESKTOP_CREDENTIAL_DELETE_CHANNEL,
        DESKTOP_LLM_CONFIGURATION_CHANNEL,
        DESKTOP_LLM_SELECTION_APPLY_CHANNEL,
        DESKTOP_CHATGPT_STATUS_CHANNEL,
        DESKTOP_CHATGPT_LOGIN_CHANNEL,
        DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL,
      ].sort(),
    );
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    expect(subject.vault.reapplyConfigured).not.toHaveBeenCalled();
    expect(
      JSON.stringify(await subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent)),
    ).not.toContain("value");
  });

  it("reads credential metadata without waiting for credential replay", async () => {
    const subject = harness();
    vi.mocked(subject.vault.reapplyConfigured).mockImplementation(
      () => new Promise<void>(() => {}),
    );

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    expect(subject.vault.credentialStatuses).toHaveBeenCalledOnce();
    expect(subject.vault.reapplyConfigured).not.toHaveBeenCalled();
  });

  it("routes strict redacted credential deletion and refuses externally managed runtime state", async () => {
    const subject = harness();

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, subject.trustedEvent, {
        credential: "anthropic",
      }),
    ).resolves.toEqual({
      credential: "anthropic",
      status: "deleted",
      cleanupPending: false,
    });
    expect(subject.vault.deleteCredential).toHaveBeenCalledWith("anthropic");

    vi.mocked(subject.vault.credentialStatuses).mockResolvedValueOnce([
      { slot: "anthropic", state: "missing", runtimeState: null },
    ]);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, subject.trustedEvent, {
        credential: "anthropic",
      }),
    ).resolves.toEqual({
      credential: "anthropic",
      status: "refused",
      reason: "managed-by-environment",
    });

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, subject.trustedEvent, {
        credential: "openai-codex",
      }),
    ).resolves.toEqual({
      credential: "openai-codex",
      status: "deleted",
      cleanupPending: false,
    });
    expect(subject.chatGptAuth.deleteCredential).toHaveBeenCalledOnce();
  });

  it("rejects untrusted, widened, and unknown credential deletion inputs", async () => {
    const subject = harness();
    for (const [event, input] of [
      [{} as IpcMainInvokeEvent, { credential: "anthropic" }],
      [subject.trustedEvent, { credential: "unknown" }],
      [subject.trustedEvent, { credential: "anthropic", extra: true }],
    ] as const) {
      await expect(
        subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, event, input),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(subject.vault.deleteCredential).not.toHaveBeenCalled();
  });

  it("fails closed to re-entry metadata when stored status cannot be read", async () => {
    const subject = harness();
    vi.mocked(subject.vault.credentialStatuses).mockRejectedValueOnce(
      new Error("private storage detail"),
    );

    const statuses = await subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent);

    expect(statuses).toHaveLength(10);
    expect(statuses).toContainEqual({
      slot: "anthropic",
      state: "re-prompt",
      runtimeState: null,
    });
    expect(JSON.stringify(statuses)).not.toContain("private storage detail");
    expect(subject.vault.reapplyConfigured).not.toHaveBeenCalled();
  });

  it("retries only failed credentials through the explicit vault path", async () => {
    const subject = harness();
    vi.mocked(subject.vault.credentialStatuses).mockResolvedValueOnce([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_RETRY_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    expect(subject.vault.retryFailed).toHaveBeenCalledOnce();
    expect(subject.vault.reapplyConfigured).not.toHaveBeenCalled();
  });

  it("returns only the ordered public catalogue and minimized active selection", async () => {
    const subject = harness();

    const result = (await subject.invoke(
      DESKTOP_LLM_CONFIGURATION_CHANNEL,
      subject.trustedEvent,
    )) as {
      readonly schemaVersion: number;
      readonly providers: readonly Record<string, unknown>[];
      readonly active: Record<string, unknown>;
    };

    expect(result.schemaVersion).toBe(1);
    expect(result.providers.map((provider) => provider.provider)).toEqual([
      "anthropic",
      "openai",
      "google",
      "openai-codex",
      "deepseek",
      "qwen",
      "minimax",
      "kimi",
      "zai",
      "openrouter",
    ]);
    expect(result.active).toEqual({
      provider: "anthropic",
      model: "athlete-selected-model",
    });
    expect(Object.keys(result.active).sort()).toEqual(["model", "provider"]);
    expect(JSON.stringify(result)).not.toMatch(/credential|api[_-]?key|path|error/i);
    await expect(
      subject.invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL, {} as IpcMainInvokeEvent),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL, subject.trustedEvent, null),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("keeps the catalogue available with a null active selection when snapshotting fails", async () => {
    const subject = harness();
    subject.getRuntimeConfig.mockRejectedValueOnce(new Error("private daemon path and token"));

    const result = (await subject.invoke(
      DESKTOP_LLM_CONFIGURATION_CHANNEL,
      subject.trustedEvent,
    )) as { readonly providers: readonly unknown[]; readonly active: unknown };

    expect(result.providers).toHaveLength(10);
    expect(result.active).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private daemon path and token");
  });

  it("dispatches strict model selection to a stored key or stored ChatGPT profile", async () => {
    const subject = harness();
    const apiSelection = {
      provider: "openrouter",
      model: "  athlete-model  ",
      endpoint: { mode: "custom", value: "  https://models.example.invalid/v1  " },
    };
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, apiSelection),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
    expect(subject.vault.applyLlmSelection).toHaveBeenCalledWith({
      provider: "openrouter",
      model: "athlete-model",
      endpoint: { mode: "custom", value: "https://models.example.invalid/v1" },
    });

    const chatGpt = {
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      endpoint: { mode: "automatic" },
    };
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, chatGpt),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
    expect(subject.chatGptAuth.activate).toHaveBeenCalledWith(chatGpt);
  });

  it.each([
    {
      description: "API credential",
      selection: {
        provider: "anthropic" as const,
        model: "athlete-selected-model",
        endpoint: { mode: "automatic" as const },
      },
    },
    {
      description: "custom ChatGPT profile",
      selection: {
        provider: "openai-codex" as const,
        model: "gpt-5.4-mini",
        endpoint: { mode: "automatic" as const },
      },
    },
  ])(
    "preserves an active $description without requiring Desktop-owned credentials",
    async ({ selection }) => {
      const subject = harness();
      subject.applyExistingLlmSelection.mockResolvedValueOnce(true);

      await expect(
        subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
      ).resolves.toEqual({ status: "configured", runtimeReady: true });

      expect(subject.applyExistingLlmSelection).toHaveBeenCalledWith(selection);
      expect(subject.vault.applyLlmSelection).not.toHaveBeenCalled();
      expect(subject.chatGptAuth.activate).not.toHaveBeenCalled();
    },
  );

  it("fails an active-provider apply closed without falling back to another credential", async () => {
    const subject = harness();
    subject.applyExistingLlmSelection.mockRejectedValueOnce(new Error("private runtime failure"));

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, {
        provider: "anthropic",
        model: "athlete-selected-model",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });

    expect(subject.vault.applyLlmSelection).not.toHaveBeenCalled();
    expect(subject.chatGptAuth.activate).not.toHaveBeenCalled();
  });

  it("returns fixed selection refusals and rejects unsafe endpoint shapes", async () => {
    const subject = harness();
    vi.mocked(subject.vault.applyLlmSelection)
      .mockResolvedValueOnce({ status: "refused", reason: "credential-required" })
      .mockRejectedValueOnce(new Error("private runtime failure"));
    const automatic = {
      provider: "anthropic",
      model: "model",
      endpoint: { mode: "automatic" },
    };
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, automatic),
    ).resolves.toEqual({ status: "refused", reason: "credential-required" });
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, automatic),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });

    for (const selection of [
      { provider: "anthropic", model: "model", endpoint: { mode: "default" } },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "http://models.example.invalid/v1" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://user:secret@example.invalid/v1" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1?secret=value" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1?" },
      },
      {
        provider: "openrouter",
        model: "bad\u007fmodel",
        endpoint: { mode: "automatic" },
      },
      {
        provider: "openrouter",
        model: "\nmodel",
        endpoint: { mode: "automatic" },
      },
    ]) {
      await expect(
        subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
      ).resolves.toEqual({ status: "refused", reason: "invalid-input" });
    }
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, {
        provider: "openrouter",
        model: "loopback-model",
        endpoint: { mode: "custom", value: "http://127.0.0.1:11434/v1" },
      }),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
  });

  it("passes an optional matching selection through the credential transaction", async () => {
    const subject = harness();
    const selection = {
      provider: "openrouter",
      model: "athlete-model",
      endpoint: { mode: "default" },
    };

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "openrouter",
        value: "synthetic",
        selection,
      }),
    ).resolves.toEqual({ slot: "openrouter", status: "configured", runtimeReady: true });
    expect(subject.vault.writeCredential).toHaveBeenCalledWith({
      slot: "openrouter",
      value: "synthetic",
      selection,
    });
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "anthropic",
        value: "synthetic",
        selection,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "intervals-icu",
        value: "synthetic",
        selection,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("gates strict ChatGPT status and login invokes", async () => {
    const subject = harness();
    await expect(
      subject.invoke(DESKTOP_CHATGPT_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual({ state: "configured", runtimeReady: true });
    await expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, subject.trustedEvent, {
        provider: "openai-codex",
        model: "gpt-5.5",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
    await expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, {} as IpcMainInvokeEvent),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CHATGPT_STATUS_CHANNEL, subject.trustedEvent, null),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, subject.trustedEvent),
    ).rejects.toBeInstanceOf(TypeError);
    expect(subject.chatGptAuth.status).toHaveBeenCalledOnce();
    expect(subject.chatGptAuth.login).toHaveBeenCalledOnce();
  });

  it("validates trusted senders and exact credential inputs before dispatch", async () => {
    const subject = harness();
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, {} as IpcMainInvokeEvent, {
        slot: "anthropic",
        value: "synthetic",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "unknown",
        value: "synthetic",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "anthropic",
        value: "synthetic",
        extra: true,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "anthropic",
        value: "synthetic",
      }),
    ).resolves.toEqual({ slot: "anthropic", status: "configured", runtimeReady: false });
    expect(subject.vault.writeCredential).toHaveBeenCalledTimes(1);
    expect(subject.vault.writeCredential).toHaveBeenCalledWith(
      { slot: "anthropic", value: "synthetic" },
      { activate: false },
    );
  });

  it("minimizes failures without exposing raw errors", async () => {
    const subject = harness();
    vi.mocked(subject.vault.writeCredential).mockResolvedValueOnce({
      slot: "anthropic",
      status: "refused",
      reason: "runtime-unavailable",
    });
    const result = await subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
      slot: "anthropic",
      value: "synthetic",
    });
    expect(result).toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "runtime-unavailable",
    });
    expect(Object.keys(result as object)).toEqual(["slot", "status", "reason"]);
  });

  it("uses the bounded native chooser and filters its result", async () => {
    const subject = harness();
    await expect(
      subject.invoke(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual(["/synthetic/ride.fit"]);
    expect(subject.dialog.showOpenDialog).toHaveBeenCalledWith(expect.anything(), {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Ride files", extensions: ["fit", "tcx", "gpx"] }],
    });
    subject.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(
      subject.invoke(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual([]);
  });

  it("disposes only its nine handlers", () => {
    const subject = harness();
    subject.dispose();
    expect(subject.handlers.size).toBe(0);
    expect(subject.ipcMain.removeHandler).toHaveBeenCalledTimes(9);
  });
});
