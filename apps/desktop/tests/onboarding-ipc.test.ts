import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL,
  DESKTOP_CHATGPT_LOGIN_CHANNEL,
  DESKTOP_CHATGPT_STATUS_CHANNEL,
  DESKTOP_CREDENTIAL_RETRY_CHANNEL,
  DESKTOP_CREDENTIAL_STATUS_CHANNEL,
  DESKTOP_CREDENTIAL_WRITE_CHANNEL,
  registerOnboardingIpc,
  runtimeConfigurationForCredential,
} from "../src/main/onboarding-ipc.js";
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
    writeCredential: vi.fn(async (input) => ({
      slot: input.slot,
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
  };
  const trustedEvent = {} as IpcMainInvokeEvent;
  const dispose = registerOnboardingIpc({
    ipcMain: ipcMain as never,
    dialog,
    window: {} as never,
    vault,
    chatGptAuth,
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
      llm: { provider: "anthropic", model: "claude-sonnet-4-6", api_key: "synthetic" },
    });
    expect(runtimeConfigurationForCredential("openrouter", "synthetic")).toEqual({
      llm: {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        api_key: "synthetic",
      },
    });
    expect(runtimeConfigurationForCredential("intervals-icu", "synthetic")).toEqual({
      intervals: { api_key: "synthetic", athlete_id: "0" },
    });
  });

  it("registers only semantic onboarding channels and returns metadata", async () => {
    const subject = harness();
    expect([...subject.handlers.keys()].sort()).toEqual(
      [
        DESKTOP_CREDENTIAL_STATUS_CHANNEL,
        DESKTOP_CREDENTIAL_RETRY_CHANNEL,
        DESKTOP_CREDENTIAL_WRITE_CHANNEL,
        DESKTOP_CHATGPT_STATUS_CHANNEL,
        DESKTOP_CHATGPT_LOGIN_CHANNEL,
        DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL,
      ].sort(),
    );
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    expect(subject.vault.reapplyConfigured).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify(await subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent)),
    ).not.toContain("value");
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

  it("gates strict ChatGPT status and login invokes", async () => {
    const subject = harness();
    await expect(
      subject.invoke(DESKTOP_CHATGPT_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual({ state: "configured", runtimeReady: true });
    await expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
    await expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, {} as IpcMainInvokeEvent),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CHATGPT_STATUS_CHANNEL, subject.trustedEvent, null),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, subject.trustedEvent, null),
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
    ).resolves.toEqual({ slot: "anthropic", status: "configured", runtimeReady: true });
    expect(subject.vault.writeCredential).toHaveBeenCalledTimes(1);
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

  it("disposes only its six handlers", () => {
    const subject = harness();
    subject.dispose();
    expect(subject.handlers.size).toBe(0);
    expect(subject.ipcMain.removeHandler).toHaveBeenCalledTimes(6);
  });
});
