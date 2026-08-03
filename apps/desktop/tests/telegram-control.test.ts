import {
  TelegramControlSnapshotSchema,
  type AthleteHomeIdentity,
  type TelegramAllowedSendersResult,
  type TelegramControlSnapshot,
  type TelegramCredentialInspection,
} from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createTelegramControlCoordinator,
  type DesktopTelegramSnapshot,
  type TelegramDaemonBinding,
} from "../src/main/telegram-control.js";
import type {
  TelegramBotMetadata,
  TelegramCredentialVault,
} from "../src/main/telegram-credential-vault.js";

const HOME = "/synthetic/athlete" as AthleteHomeIdentity;
const OTHER_HOME = "/synthetic/other" as AthleteHomeIdentity;
const TOKEN = "123456:synthetic-token";
const REPLACEMENT_TOKEN = "654321:replacement-token";
const USERNAME = "desktop_bot";
const REPLACEMENT_USERNAME = "replacement_bot";
const EXPIRES_AT = "2026-08-03T12:01:00.000Z";

const readyBot = (username = USERNAME) => ({ state: "ready", username }) as const;

const daemonSnapshot = (
  channel: TelegramControlSnapshot["channel"] = {
    desiredState: "disabled",
    state: "disabled",
  },
  options: {
    readonly username?: string;
    readonly pairing?: TelegramControlSnapshot["pairing"];
  } = {},
): TelegramControlSnapshot => ({
  channel,
  bot: readyBot(options.username),
  pairing: options.pairing ?? { state: "unpaired" },
});

const desktopSnapshot = (
  channel: DesktopTelegramSnapshot["channel"] = {
    desiredState: "disabled",
    state: "disabled",
  },
  options: {
    readonly username?: string;
    readonly pairing?: DesktopTelegramSnapshot["pairing"];
    readonly configured?: boolean;
    readonly bot?: DesktopTelegramSnapshot["bot"];
  } = {},
): DesktopTelegramSnapshot => ({
  channel,
  bot: options.bot ?? readyBot(options.username),
  pairing: options.pairing ?? { state: "unpaired" },
  credentialConfigured: options.configured ?? true,
});

function subject(
  options: {
    readonly home?: AthleteHomeIdentity;
    readonly daemonHome?: AthleteHomeIdentity;
    readonly supervision?: "app-supervised" | "attached";
    readonly configured?: boolean;
    readonly enabled?: boolean;
    readonly inspection?: TelegramCredentialInspection;
    readonly metadata?: TelegramBotMetadata;
    readonly loseReplacementAcknowledgement?: "malformed" | "rejected";
  } = {},
) {
  let selectedHome = options.home ?? HOME;
  let token = options.configured === false ? undefined : TOKEN;
  let enabled = options.enabled ?? false;
  let metadata: TelegramBotMetadata =
    options.metadata ??
    (token === undefined ? { state: "missing" } : { state: "configured", username: USERNAME });
  let inspection: TelegramCredentialInspection = options.inspection ?? {
    status: "ready",
    bot: { id: 20002, username: REPLACEMENT_USERNAME },
  };
  let daemonToken = token;
  let loseReplacementAcknowledgement = options.loseReplacementAcknowledgement;
  let senders: TelegramAllowedSendersResult = {
    senders: [{ senderId: 12345, role: "primary", addedAt: "2026-08-03T12:00:00.000Z" }],
  };
  const trace: string[] = [];
  const vault: TelegramCredentialVault = {
    credentialStatus: vi.fn(
      async () =>
        ({
          state: token === undefined ? "missing" : "configured",
        }) as const,
    ),
    writeCredential: vi.fn(async (input) => {
      trace.push(`vault:token:${input.token}`);
      if (input.authenticatedAthleteHome !== HOME) {
        return { status: "refused", reason: "wrong-home" } as const;
      }
      token = input.token;
      return { status: "configured" } as const;
    }),
    applyStoredCredential: vi.fn(async (authenticatedHome, apply) => {
      trace.push("vault:read-token");
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
      trace.push("vault:delete");
      token = undefined;
      metadata = { state: "missing" };
      return { status: "deleted", cleanupPending: false } as const;
    }),
    botMetadata: vi.fn(async () => metadata),
    writeBotMetadata: vi.fn(async (input) => {
      trace.push(`vault:metadata:${input.username}`);
      if (input.authenticatedAthleteHome !== HOME) {
        return { status: "refused", reason: "wrong-home" } as const;
      }
      metadata = { state: "configured", username: input.username };
      return { status: "stored", username: input.username } as const;
    }),
    deleteBotMetadata: vi.fn(async () => {
      trace.push("vault:delete-metadata");
      metadata = { state: "missing" };
      return { status: "deleted", cleanupPending: false } as const;
    }),
    desiredState: vi.fn(async () => ({ state: "configured", enabled }) as const),
    setDesiredState: vi.fn(async (next) => {
      trace.push(`vault:desired:${String(next)}`);
      enabled = next;
      return { status: "stored", enabled: next } as const;
    }),
  };
  const binding: TelegramDaemonBinding = {
    generation: 1,
    athleteHome: options.daemonHome ?? HOME,
    supervision: options.supervision ?? "app-supervised",
    configureTelegram: vi.fn(async ({ token: value }) => {
      trace.push(`daemon:configure:${value}`);
      return daemonSnapshot(
        enabled
          ? { desiredState: "enabled", state: "starting" }
          : { desiredState: "disabled", state: "disabled" },
        { username: metadata.state === "configured" ? metadata.username : USERNAME },
      );
    }),
    enableTelegram: vi.fn(async () => {
      trace.push("daemon:enable");
      return daemonSnapshot(
        { desiredState: "enabled", state: "online" },
        {
          username: metadata.state === "configured" ? metadata.username : USERNAME,
        },
      );
    }),
    disableTelegram: vi.fn(async () => {
      trace.push("daemon:disable");
      return daemonSnapshot(
        { desiredState: "disabled", state: "disabled" },
        {
          username: metadata.state === "configured" ? metadata.username : USERNAME,
        },
      );
    }),
    replaceTelegram: vi.fn(async ({ token: value }) => {
      trace.push(`daemon:replace:${value}`);
      daemonToken = value;
      if (loseReplacementAcknowledgement !== undefined) {
        const lost = loseReplacementAcknowledgement;
        loseReplacementAcknowledgement = undefined;
        if (lost === "rejected") throw new Error("replacement acknowledgement lost");
        return { malformed: true };
      }
      return daemonSnapshot(
        enabled
          ? { desiredState: "enabled", state: "online" }
          : { desiredState: "disabled", state: "disabled" },
        { username: metadata.state === "configured" ? metadata.username : USERNAME },
      );
    }),
    getTelegramStatus: vi.fn(async () =>
      daemonSnapshot(
        enabled
          ? { desiredState: "enabled", state: "online" }
          : { desiredState: "disabled", state: "disabled" },
        { username: metadata.state === "configured" ? metadata.username : USERNAME },
      ),
    ),
    reconcileTelegram: vi.fn(async () => {
      trace.push("daemon:reconcile");
      return daemonSnapshot(
        { desiredState: "enabled", state: "online" },
        {
          username: metadata.state === "configured" ? metadata.username : USERNAME,
        },
      );
    }),
    resetTelegramAccess: vi.fn(async () => {
      trace.push("daemon:reset-access");
      senders = { senders: [] };
      return daemonSnapshot({ desiredState: "disabled", state: "disabled" });
    }),
    inspectTelegramCredential: vi.fn(async ({ token: value }) => {
      trace.push(`daemon:inspect:${value}`);
      return inspection;
    }),
    deleteTelegramWebhook: vi.fn(async ({ token: value }) => {
      trace.push(`daemon:delete-webhook:${value}`);
      inspection = { status: "ready", bot: { id: 10001, username: USERNAME } };
      return inspection;
    }),
    forgetTelegramCredential: vi.fn(async () => {
      trace.push("daemon:forget");
      return {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
      };
    }),
    beginTelegramPairing: vi.fn(async () => {
      trace.push("daemon:begin-pairing");
      return daemonSnapshot(
        { desiredState: "enabled", state: "starting" },
        {
          username: metadata.state === "configured" ? metadata.username : USERNAME,
          pairing: { state: "awaiting-code", code: "ABCDEF", expiresAt: EXPIRES_AT },
        },
      );
    }),
    cancelTelegramPairing: vi.fn(async () => {
      trace.push("daemon:cancel-pairing");
      return daemonSnapshot(
        { desiredState: "disabled", state: "disabled" },
        {
          username: metadata.state === "configured" ? metadata.username : USERNAME,
        },
      );
    }),
    listTelegramAllowedSenders: vi.fn(async () => senders),
    addTelegramAllowedSender: vi.fn(async ({ senderId }) => {
      trace.push(`daemon:add:${String(senderId)}`);
      senders = {
        senders: [...senders.senders, { senderId, role: "additional" }],
      };
      return senders;
    }),
    removeTelegramAllowedSender: vi.fn(async ({ senderId }) => {
      trace.push(`daemon:remove:${String(senderId)}`);
      senders = { senders: senders.senders.filter((sender) => sender.senderId !== senderId) };
      return senders;
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
    currentMetadata: () => metadata,
    currentToken: () => token,
    currentDaemonToken: () => daemonToken,
    setCurrent(value: TelegramDaemonBinding | undefined) {
      current = value;
    },
    setInspection(value: TelegramCredentialInspection) {
      inspection = value;
    },
    setSelectedHome(value: AthleteHomeIdentity) {
      selectedHome = value;
    },
  };
}

describe("Telegram main-process control coordinator", () => {
  it("preflights before metadata and credential writes and returns a strict redacted snapshot", async () => {
    const runtime = subject({ configured: false });

    const result = await runtime.coordinator.configure(REPLACEMENT_TOKEN);

    expect(result).toEqual(desktopSnapshot(undefined, { username: REPLACEMENT_USERNAME }));
    expect(runtime.trace).toEqual([
      `daemon:inspect:${REPLACEMENT_TOKEN}`,
      "vault:read-token",
      `vault:metadata:${REPLACEMENT_USERNAME}`,
      `vault:token:${REPLACEMENT_TOKEN}`,
      "vault:desired:false",
      `daemon:configure:${REPLACEMENT_TOKEN}`,
    ]);
    expect(TelegramControlSnapshotSchema.safeParse(result).success).toBe(false);
    expect(Object.keys(result).sort()).toEqual([
      "bot",
      "channel",
      "credentialConfigured",
      "pairing",
    ]);
    expect(JSON.stringify(result)).not.toContain(REPLACEMENT_TOKEN);
  });

  it.each([
    { status: "invalid-token" } as const,
    { status: "unavailable", errorCode: "telegram-validation-failed" } as const,
  ])("preserves the old credential and runtime for a $status replacement", async (candidate) => {
    const runtime = subject({ configured: true, enabled: true, inspection: candidate });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toEqual(
      desktopSnapshot({ desiredState: "enabled", state: "online" }),
    );

    expect(runtime.currentToken()).toBe(TOKEN);
    expect(runtime.currentDaemonToken()).toBe(TOKEN);
    expect(runtime.currentMetadata()).toEqual({ state: "configured", username: USERNAME });
    expect(runtime.vault.writeBotMetadata).not.toHaveBeenCalled();
    expect(runtime.vault.writeCredential).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
  });

  it.each(["malformed", "rejected"] as const)(
    "converges the daemon and vault when replacement acknowledgement is %s",
    async (lostAcknowledgement) => {
      const runtime = subject({
        configured: true,
        enabled: true,
        loseReplacementAcknowledgement: lostAcknowledgement,
      });

      await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toEqual(
        desktopSnapshot(
          { desiredState: "enabled", state: "online" },
          { username: REPLACEMENT_USERNAME },
        ),
      );

      expect(runtime.currentToken()).toBe(REPLACEMENT_TOKEN);
      expect(runtime.currentDaemonToken()).toBe(REPLACEMENT_TOKEN);
      expect(runtime.binding.replaceTelegram).toHaveBeenNthCalledWith(1, {
        token: REPLACEMENT_TOKEN,
      });
      expect(runtime.binding.replaceTelegram).toHaveBeenNthCalledWith(2, {
        token: REPLACEMENT_TOKEN,
      });
    },
  );

  it("reconciles the vault credential forward after two replacement acknowledgements are lost", async () => {
    const runtime = subject({ configured: true, enabled: true });
    vi.mocked(runtime.binding.replaceTelegram)
      .mockRejectedValueOnce(new Error("replacement acknowledgement lost"))
      .mockResolvedValueOnce({ malformed: true });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toEqual({
      channel: {
        desiredState: "enabled",
        state: "failed",
        errorCode: "telegram-control-failed",
      },
      bot: readyBot(REPLACEMENT_USERNAME),
      pairing: { state: "unpaired" },
      credentialConfigured: true,
    });
    expect(runtime.currentToken()).toBe(REPLACEMENT_TOKEN);
    expect(runtime.currentDaemonToken()).toBe(TOKEN);

    await expect(runtime.coordinator.reconcile()).resolves.toEqual(
      desktopSnapshot(
        { desiredState: "enabled", state: "online" },
        { username: REPLACEMENT_USERNAME },
      ),
    );

    expect(runtime.currentToken()).toBe(REPLACEMENT_TOKEN);
    expect(runtime.currentDaemonToken()).toBe(REPLACEMENT_TOKEN);
    expect(runtime.binding.replaceTelegram).toHaveBeenNthCalledWith(3, {
      token: REPLACEMENT_TOKEN,
    });
  });

  it("stores an initial webhook credential disabled without configuring or polling", async () => {
    const runtime = subject({
      configured: false,
      inspection: {
        status: "webhook-removal-required",
        bot: { id: 20002, username: REPLACEMENT_USERNAME },
      },
    });

    await expect(runtime.coordinator.configure(REPLACEMENT_TOKEN)).resolves.toEqual(
      desktopSnapshot(undefined, {
        username: REPLACEMENT_USERNAME,
        bot: { state: "webhook-removal-required", username: REPLACEMENT_USERNAME },
      }),
    );

    expect(runtime.currentToken()).toBe(REPLACEMENT_TOKEN);
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.trace.at(-1)).toBe("vault:desired:false");
  });

  it("refuses a webhook replacement and preserves the running credential", async () => {
    const runtime = subject({
      configured: true,
      enabled: true,
      inspection: {
        status: "webhook-removal-required",
        bot: { id: 20002, username: REPLACEMENT_USERNAME },
      },
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toEqual(
      desktopSnapshot({ desiredState: "enabled", state: "online" }),
    );

    expect(runtime.currentToken()).toBe(TOKEN);
    expect(runtime.vault.writeBotMetadata).not.toHaveBeenCalled();
    expect(runtime.vault.writeCredential).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
  });

  it("writes metadata before ciphertext and restores old metadata if token storage fails", async () => {
    const runtime = subject({ configured: true });
    vi.mocked(runtime.vault.writeCredential).mockImplementationOnce(async (input) => {
      runtime.trace.push(`vault:token:${input.token}`);
      return { status: "refused", reason: "storage-failed" };
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      channel: {
        state: "failed",
        errorCode: "telegram-credential-storage-failed",
      },
      credentialConfigured: false,
    });

    expect(runtime.trace).toEqual([
      `daemon:inspect:${REPLACEMENT_TOKEN}`,
      "vault:read-token",
      `vault:metadata:${REPLACEMENT_USERNAME}`,
      `vault:token:${REPLACEMENT_TOKEN}`,
      `vault:metadata:${USERNAME}`,
    ]);
    expect(runtime.currentToken()).toBe(TOKEN);
    expect(runtime.currentMetadata()).toEqual({ state: "configured", username: USERNAME });
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
  });

  it("fails closed on home and generation changes before mutating the vault", async () => {
    const wrongHome = subject({ configured: false, daemonHome: OTHER_HOME });
    await expect(wrongHome.coordinator.configure(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      channel: { state: "failed", errorCode: "telegram-daemon-unavailable" },
      credentialConfigured: false,
    });
    expect(wrongHome.binding.inspectTelegramCredential).not.toHaveBeenCalled();
    expect(wrongHome.vault.writeCredential).not.toHaveBeenCalled();

    const stale = subject({ configured: false });
    vi.mocked(stale.binding.inspectTelegramCredential).mockImplementationOnce(async () => {
      stale.setCurrent({ ...stale.binding, generation: 2 });
      return { status: "ready", bot: { id: 20002, username: REPLACEMENT_USERNAME } };
    });
    await expect(stale.coordinator.configure(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      channel: { state: "failed", errorCode: "telegram-stale-operation" },
      credentialConfigured: false,
    });
    expect(stale.vault.writeBotMetadata).not.toHaveBeenCalled();
    expect(stale.vault.writeCredential).not.toHaveBeenCalled();
  });

  it("requires transfer for an attached daemon and never replays its token", async () => {
    const runtime = subject({ supervision: "attached", configured: true, enabled: true });

    await expect(runtime.coordinator.status()).resolves.toEqual(
      desktopSnapshot({ desiredState: "enabled", state: "transfer-required" }),
    );
    await expect(runtime.coordinator.reconcile()).resolves.toEqual(
      desktopSnapshot({ desiredState: "enabled", state: "transfer-required" }),
    );

    expect(runtime.binding.getTelegramStatus).not.toHaveBeenCalled();
    expect(runtime.vault.applyStoredCredential).not.toHaveBeenCalled();
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
  });

  it("removes a webhook explicitly and only configures after reinspection is ready", async () => {
    const runtime = subject({
      configured: true,
      inspection: {
        status: "webhook-removal-required",
        bot: { id: 10001, username: USERNAME },
      },
    });

    await expect(runtime.coordinator.removeWebhook()).resolves.toEqual(desktopSnapshot());

    expect(runtime.trace).toEqual([
      "vault:read-token",
      `daemon:delete-webhook:${TOKEN}`,
      `daemon:inspect:${TOKEN}`,
      `vault:metadata:${USERNAME}`,
      `daemon:configure:${TOKEN}`,
    ]);
  });

  it("begins and cancels pairing through the single daemon lifecycle", async () => {
    const runtime = subject({ configured: true });

    await expect(runtime.coordinator.beginPairing()).resolves.toEqual(
      desktopSnapshot(
        { desiredState: "enabled", state: "starting" },
        {
          pairing: { state: "awaiting-code", code: "ABCDEF", expiresAt: EXPIRES_AT },
        },
      ),
    );
    await expect(runtime.coordinator.cancelPairing()).resolves.toEqual(desktopSnapshot());

    expect(runtime.trace).toEqual([
      "vault:read-token",
      `daemon:configure:${TOKEN}`,
      "daemon:begin-pairing",
      "vault:desired:true",
      "daemon:cancel-pairing",
      "vault:desired:false",
    ]);
  });

  it("strictly validates sender lists and forwards only sender ids", async () => {
    const runtime = subject();

    await expect(runtime.coordinator.listAllowedSenders()).resolves.toEqual({
      senders: [{ senderId: 12345, role: "primary", addedAt: "2026-08-03T12:00:00.000Z" }],
    });
    await expect(runtime.coordinator.addAllowedSender({ senderId: 67890 })).resolves.toEqual({
      senders: [
        { senderId: 12345, role: "primary", addedAt: "2026-08-03T12:00:00.000Z" },
        { senderId: 67890, role: "additional" },
      ],
    });
    await expect(runtime.coordinator.removeAllowedSender({ senderId: 67890 })).resolves.toEqual({
      senders: [{ senderId: 12345, role: "primary", addedAt: "2026-08-03T12:00:00.000Z" }],
    });
    expect(runtime.binding.addTelegramAllowedSender).toHaveBeenCalledWith({ senderId: 67890 });
    expect(runtime.binding.removeTelegramAllowedSender).toHaveBeenCalledWith({ senderId: 67890 });

    vi.mocked(runtime.binding.listTelegramAllowedSenders).mockResolvedValueOnce({
      senders: [
        { senderId: 12345, role: "primary" },
        { senderId: 12345, role: "additional" },
      ],
    });
    await expect(runtime.coordinator.listAllowedSenders()).resolves.toEqual({ senders: [] });
  });

  it("rejects allowed-sender mutations when daemon authority is unavailable", async () => {
    const runtime = subject();
    runtime.setCurrent(undefined);

    await expect(runtime.coordinator.removeAllowedSender({ senderId: 67890 })).rejects.toThrow(
      "Telegram sender authority is unavailable",
    );
    await expect(runtime.coordinator.addAllowedSender({ senderId: 67890 })).rejects.toThrow(
      "Telegram sender authority is unavailable",
    );
  });

  it("disables and forgets the daemon before deleting the vault", async () => {
    const runtime = subject({ configured: true, enabled: true });

    await expect(runtime.coordinator.remove()).resolves.toEqual(
      desktopSnapshot(undefined, {
        configured: false,
        bot: { state: "unconfigured" },
      }),
    );

    expect(runtime.trace).toEqual([
      "daemon:disable",
      "daemon:reset-access",
      "daemon:forget",
      "vault:desired:false",
      "vault:delete",
    ]);
  });

  it("retains the vault when disable or forget does not prove a completed drain", async () => {
    const refused = subject({ configured: true, enabled: true });
    vi.mocked(refused.binding.disableTelegram).mockResolvedValueOnce(
      daemonSnapshot({
        desiredState: "enabled",
        state: "conflict",
        errorCode: "telegram-polling-conflict",
      }),
    );
    await expect(refused.coordinator.remove()).resolves.toMatchObject({
      channel: { state: "failed", errorCode: "telegram-drain-required" },
      credentialConfigured: true,
    });
    expect(refused.binding.forgetTelegramCredential).not.toHaveBeenCalled();
    expect(refused.vault.deleteCredential).not.toHaveBeenCalled();

    const forgetRefused = subject({ configured: true, enabled: true });
    vi.mocked(forgetRefused.binding.forgetTelegramCredential).mockResolvedValueOnce(
      daemonSnapshot({ desiredState: "disabled", state: "disabled" }),
    );
    await expect(forgetRefused.coordinator.remove()).resolves.toMatchObject({
      channel: { state: "failed", errorCode: "telegram-drain-required" },
      credentialConfigured: true,
    });
    expect(forgetRefused.vault.deleteCredential).not.toHaveBeenCalled();
  });

  it("retains the credential until access reset proves the daemon is disabled and unpaired", async () => {
    const runtime = subject({ configured: true, enabled: true });
    vi.mocked(runtime.binding.resetTelegramAccess).mockResolvedValueOnce(
      daemonSnapshot(
        { desiredState: "disabled", state: "disabled" },
        {
          pairing: { state: "awaiting-code", code: "ABCDEF", expiresAt: EXPIRES_AT },
        },
      ),
    );

    await expect(runtime.coordinator.remove()).resolves.toMatchObject({
      channel: { state: "failed", errorCode: "telegram-drain-required" },
      credentialConfigured: true,
    });

    expect(runtime.binding.forgetTelegramCredential).not.toHaveBeenCalled();
    expect(runtime.vault.deleteCredential).not.toHaveBeenCalled();
    expect(runtime.currentToken()).toBe(TOKEN);
  });
});
