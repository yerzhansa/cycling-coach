import type { AthleteHomeIdentity } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createTelegramControlCoordinator,
  type TelegramDaemonBinding,
} from "../src/main/telegram-control.js";
import type { TelegramCredentialVault } from "../src/main/telegram-credential-vault.js";

const HOME = "/synthetic/athlete" as AthleteHomeIdentity;
const OTHER_HOME = "/synthetic/other" as AthleteHomeIdentity;
const TOKEN = "123456:synthetic-token";

function subject(
  options: {
    readonly home?: AthleteHomeIdentity;
    readonly daemonHome?: AthleteHomeIdentity;
    readonly supervision?: "app-supervised" | "attached";
    readonly configured?: boolean;
    readonly enabled?: boolean;
  } = {},
) {
  let selectedHome = options.home ?? HOME;
  let token = options.configured === false ? undefined : TOKEN;
  let enabled = options.enabled ?? false;
  const trace: string[] = [];
  const vault: TelegramCredentialVault = {
    credentialStatus: vi.fn(
      async () =>
        ({
          state: token === undefined ? "missing" : "configured",
        }) as const,
    ),
    writeCredential: vi.fn(async (input) => {
      trace.push("write");
      if (input.authenticatedAthleteHome !== HOME) {
        return { status: "refused", reason: "wrong-home" } as const;
      }
      token = input.token;
      return { status: "configured" } as const;
    }),
    applyStoredCredential: vi.fn(async (authenticatedHome, apply) => {
      trace.push("decrypt");
      if (authenticatedHome !== HOME) {
        return { status: "refused", reason: "wrong-home" } as const;
      }
      if (token === undefined) return { status: "refused", reason: "missing" } as const;
      try {
        await apply(token);
        return { status: "applied" } as const;
      } catch {
        return { status: "refused", reason: "runtime-unavailable" } as const;
      }
    }),
    deleteCredential: vi.fn(async () => {
      trace.push("delete");
      token = undefined;
      return { status: "deleted", cleanupPending: false } as const;
    }),
    desiredState: vi.fn(async () => ({ state: "configured", enabled }) as const),
    setDesiredState: vi.fn(async (next) => {
      enabled = next;
      return { status: "stored", enabled: next } as const;
    }),
  };
  const binding: TelegramDaemonBinding = {
    generation: 1,
    athleteHome: options.daemonHome ?? HOME,
    supervision: options.supervision ?? "app-supervised",
    configureTelegram: vi.fn(async () => {
      trace.push("configure");
      return {
        desiredState: enabled ? "enabled" : "disabled",
        state: enabled ? "starting" : "disabled",
      };
    }),
    enableTelegram: vi.fn(async () => {
      trace.push("enable");
      return { desiredState: "enabled", state: "online" };
    }),
    disableTelegram: vi.fn(async () => {
      trace.push("disable");
      return { desiredState: "disabled", state: "disabled" };
    }),
    replaceTelegram: vi.fn(async () => {
      trace.push("replace");
      return {
        desiredState: enabled ? "enabled" : "disabled",
        state: enabled ? "online" : "disabled",
      };
    }),
    getTelegramStatus: vi.fn(async () => ({
      desiredState: enabled ? "enabled" : "disabled",
      state: enabled ? "online" : "disabled",
    })),
    reconcileTelegram: vi.fn(async () => {
      trace.push("reconcile");
      return { desiredState: "enabled", state: "online" };
    }),
  };
  let current: TelegramDaemonBinding | undefined = binding;
  const coordinator = createTelegramControlCoordinator({
    selectedAthleteHome: () => selectedHome,
    vault,
    daemon: { current: () => current },
  });
  return {
    binding,
    coordinator,
    trace,
    vault,
    setCurrent(value: TelegramDaemonBinding | undefined) {
      current = value;
    },
    setSelectedHome(value: AthleteHomeIdentity) {
      selectedHome = value;
    },
  };
}

describe("Telegram main-process control coordinator", () => {
  it("serializes credential configuration and enablement without returning plaintext", async () => {
    const runtime = subject();
    let releaseWrite!: () => void;
    vi.mocked(runtime.vault.writeCredential).mockImplementationOnce(
      (input) =>
        new Promise((resolve) => {
          runtime.trace.push("write-pending");
          releaseWrite = () => resolve({ status: "configured" });
          expect(input.token).toBe(TOKEN);
        }),
    );

    const configuring = runtime.coordinator.configure(TOKEN);
    const enabling = runtime.coordinator.enable();
    await vi.waitFor(() => expect(runtime.trace).toEqual(["write-pending"]));
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    releaseWrite();

    await expect(configuring).resolves.toEqual({ desiredState: "disabled", state: "disabled" });
    await expect(enabling).resolves.toEqual({ desiredState: "enabled", state: "online" });
    expect(runtime.trace).toEqual([
      "write-pending",
      "decrypt",
      "configure",
      "decrypt",
      "configure",
      "enable",
    ]);
    expect(JSON.stringify(await enabling)).not.toContain(TOKEN);
  });

  it("fails closed before plaintext use when the selected and daemon homes differ", async () => {
    const runtime = subject({ daemonHome: OTHER_HOME });
    await expect(runtime.coordinator.configure(TOKEN)).resolves.toEqual({
      desiredState: "disabled",
      state: "failed",
      errorCode: "telegram-daemon-unavailable",
    });
    expect(runtime.vault.writeCredential).not.toHaveBeenCalled();
    expect(runtime.vault.applyStoredCredential).not.toHaveBeenCalled();
  });

  it("maps a decrypted-record home refusal to a closed home-mismatch result", async () => {
    const runtime = subject();
    vi.mocked(runtime.vault.applyStoredCredential).mockResolvedValueOnce({
      status: "refused",
      reason: "wrong-home",
    });
    await expect(runtime.coordinator.configure(TOKEN)).resolves.toEqual({
      desiredState: "disabled",
      state: "failed",
      errorCode: "telegram-home-mismatch",
    });
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
  });

  it("rejects a daemon object or generation change after the credential RPC", async () => {
    const runtime = subject();
    vi.mocked(runtime.binding.configureTelegram).mockImplementationOnce(async () => {
      runtime.setCurrent({ ...runtime.binding, generation: 2 });
      return { desiredState: "disabled", state: "disabled" };
    });
    await expect(runtime.coordinator.configure(TOKEN)).resolves.toEqual({
      desiredState: "disabled",
      state: "failed",
      errorCode: "telegram-stale-operation",
    });
  });

  it("replays credentials only to an app-supervised daemon", async () => {
    const attached = subject({ supervision: "attached", enabled: true });
    await expect(attached.coordinator.reconcile()).resolves.toEqual({
      desiredState: "enabled",
      state: "transfer-required",
    });
    expect(attached.vault.applyStoredCredential).not.toHaveBeenCalled();

    const supervised = subject({ enabled: true });
    await expect(supervised.coordinator.reconcile()).resolves.toEqual({
      desiredState: "enabled",
      state: "online",
    });
    expect(supervised.trace).toEqual(["decrypt", "configure", "reconcile"]);
  });

  it("reports waiting-for-credential when enabled state has no stored token", async () => {
    const runtime = subject({ configured: false, enabled: true });
    await expect(runtime.coordinator.status()).resolves.toEqual({
      desiredState: "enabled",
      state: "waiting-for-credential",
    });
    await expect(runtime.coordinator.reconcile()).resolves.toEqual({
      desiredState: "enabled",
      state: "waiting-for-credential",
    });
  });

  it("returns only allowlisted status metadata", async () => {
    const runtime = subject({ enabled: true });
    vi.mocked(runtime.binding.getTelegramStatus).mockResolvedValueOnce({
      desiredState: "enabled",
      state: "online",
      botUsername: "synthetic_bot",
      retryCount: 2,
      token: TOKEN,
      exception: "private failure text",
      athleteMessage: "private athlete text",
    });
    await expect(runtime.coordinator.status()).resolves.toEqual({
      desiredState: "enabled",
      state: "online",
      botUsername: "synthetic_bot",
      retryCount: 2,
    });
  });

  it("drains the channel before deleting ciphertext and retains it on drain refusal", async () => {
    const runtime = subject({ enabled: true });
    await expect(runtime.coordinator.remove()).resolves.toEqual({
      desiredState: "enabled",
      state: "waiting-for-credential",
    });
    expect(runtime.trace).toEqual(["disable", "delete"]);

    const refused = subject({ enabled: true });
    vi.mocked(refused.binding.disableTelegram).mockResolvedValueOnce({
      desiredState: "enabled",
      state: "conflict",
      errorCode: "telegram-polling-conflict",
    });
    await expect(refused.coordinator.remove()).resolves.toMatchObject({
      state: "failed",
      errorCode: "telegram-drain-required",
    });
    expect(refused.vault.deleteCredential).not.toHaveBeenCalled();
  });

  it("contains channel failures and continues serving later operations", async () => {
    const runtime = subject();
    vi.mocked(runtime.binding.getTelegramStatus)
      .mockRejectedValueOnce(new Error(`do not surface ${TOKEN}`))
      .mockResolvedValueOnce({ desiredState: "disabled", state: "disabled" });
    await expect(runtime.coordinator.status()).resolves.toEqual({
      desiredState: "disabled",
      state: "failed",
      errorCode: "telegram-control-failed",
    });
    await expect(runtime.coordinator.status()).resolves.toEqual({
      desiredState: "disabled",
      state: "disabled",
    });
  });
});
