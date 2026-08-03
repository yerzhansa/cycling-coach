import {
  TelegramAllowedSendersResultSchema,
  TelegramControlSnapshotSchema,
  TelegramCredentialInspectionSchema,
  type AthleteHomeIdentity,
  type TelegramAllowedSenderRpcParams,
  type TelegramAllowedSendersResult,
  type TelegramBotState,
  type TelegramChannelStatus,
  type TelegramControlSnapshot,
  type TelegramCredentialInspection,
  type TelegramPairingState,
} from "@enduragent/coach-contract";
import type {
  TelegramBotMetadata,
  TelegramCredentialApplyResult,
  TelegramCredentialStatus,
  TelegramCredentialVault,
  TelegramDesiredState,
} from "./telegram-credential-vault.js";

type EmptyRpcParams = Readonly<Record<string, never>>;

export const DESKTOP_TELEGRAM_CONTROL_ERROR_CODES = [
  "telegram-credential-storage-failed",
  "telegram-credential-unavailable",
  "telegram-daemon-unavailable",
  "telegram-home-mismatch",
  "telegram-stale-operation",
  "telegram-control-failed",
  "telegram-drain-required",
] as const;

export type DesktopTelegramControlErrorCode =
  (typeof DESKTOP_TELEGRAM_CONTROL_ERROR_CODES)[number];

export type DesktopTelegramChannelStatus =
  | TelegramChannelStatus
  | Readonly<{ desiredState: "enabled"; state: "transfer-required" }>
  | Readonly<{
      desiredState: "disabled" | "enabled";
      state: "failed";
      errorCode: DesktopTelegramControlErrorCode;
    }>;

export interface DesktopTelegramSnapshot {
  readonly channel: DesktopTelegramChannelStatus;
  readonly bot: TelegramBotState;
  readonly pairing: TelegramPairingState;
  readonly credentialConfigured: boolean;
}

export interface TelegramDaemonBinding {
  readonly generation: number;
  readonly athleteHome: AthleteHomeIdentity;
  readonly supervision: "app-supervised" | "attached";
  configureTelegram(input: { readonly token: string }): Promise<unknown>;
  enableTelegram(input: EmptyRpcParams): Promise<unknown>;
  disableTelegram(input: EmptyRpcParams): Promise<unknown>;
  replaceTelegram(input: { readonly token: string }): Promise<unknown>;
  getTelegramStatus(input: EmptyRpcParams): Promise<unknown>;
  reconcileTelegram(input: EmptyRpcParams): Promise<unknown>;
  inspectTelegramCredential(input: { readonly token: string }): Promise<unknown>;
  deleteTelegramWebhook(input: { readonly token: string }): Promise<unknown>;
  forgetTelegramCredential(input: EmptyRpcParams): Promise<unknown>;
  beginTelegramPairing(input: EmptyRpcParams): Promise<unknown>;
  cancelTelegramPairing(input: EmptyRpcParams): Promise<unknown>;
  listTelegramAllowedSenders(input: EmptyRpcParams): Promise<unknown>;
  addTelegramAllowedSender(input: TelegramAllowedSenderRpcParams): Promise<unknown>;
  removeTelegramAllowedSender(input: TelegramAllowedSenderRpcParams): Promise<unknown>;
}

export interface TelegramDaemonAuthorityPort {
  current(): TelegramDaemonBinding | undefined;
}

export interface TelegramControlCoordinator {
  configure(token: string): Promise<DesktopTelegramSnapshot>;
  replace(token: string): Promise<DesktopTelegramSnapshot>;
  enable(): Promise<DesktopTelegramSnapshot>;
  disable(): Promise<DesktopTelegramSnapshot>;
  stopPolling(): Promise<DesktopTelegramSnapshot>;
  remove(): Promise<DesktopTelegramSnapshot>;
  removeWebhook(): Promise<DesktopTelegramSnapshot>;
  status(): Promise<DesktopTelegramSnapshot>;
  reconcile(): Promise<DesktopTelegramSnapshot>;
  beginPairing(): Promise<DesktopTelegramSnapshot>;
  cancelPairing(): Promise<DesktopTelegramSnapshot>;
  listAllowedSenders(): Promise<TelegramAllowedSendersResult>;
  addAllowedSender(input: TelegramAllowedSenderRpcParams): Promise<TelegramAllowedSendersResult>;
  removeAllowedSender(input: TelegramAllowedSenderRpcParams): Promise<TelegramAllowedSendersResult>;
}

export interface CreateTelegramControlCoordinatorInput {
  readonly selectedAthleteHome: () => AthleteHomeIdentity;
  readonly vault: Pick<
    TelegramCredentialVault,
    | "credentialStatus"
    | "writeCredential"
    | "applyStoredCredential"
    | "deleteCredential"
    | "botMetadata"
    | "writeBotMetadata"
    | "deleteBotMetadata"
    | "desiredState"
    | "setDesiredState"
  >;
  readonly daemon: TelegramDaemonAuthorityPort;
}

const DISABLED_CHANNEL = Object.freeze({ desiredState: "disabled", state: "disabled" } as const);
const UNCONFIGURED_BOT = Object.freeze({ state: "unconfigured" } as const);
const UNPAIRED = Object.freeze({ state: "unpaired" } as const);
const emptySenders = (): TelegramAllowedSendersResult => ({ senders: [] });

function desiredFromRecord(value: TelegramDesiredState): "disabled" | "enabled" {
  return value.state === "configured" && value.enabled ? "enabled" : "disabled";
}

function failure(
  desiredState: "disabled" | "enabled",
  errorCode: DesktopTelegramControlErrorCode,
  credentialConfigured = false,
  bot: TelegramBotState = UNCONFIGURED_BOT,
  pairing: TelegramPairingState = UNPAIRED,
): DesktopTelegramSnapshot {
  return {
    channel: { desiredState, state: "failed", errorCode },
    bot,
    pairing,
    credentialConfigured,
  };
}

function parseSnapshot(value: unknown): TelegramControlSnapshot | undefined {
  const parsed = TelegramControlSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseInspection(value: unknown): TelegramCredentialInspection | undefined {
  const parsed = TelegramCredentialInspectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function credentialError(
  desiredState: "disabled" | "enabled",
  result: TelegramCredentialApplyResult,
): DesktopTelegramSnapshot {
  if (result.status === "applied") throw new TypeError("credential was applied");
  return failure(
    desiredState,
    result.reason === "wrong-home"
      ? "telegram-home-mismatch"
      : result.reason === "runtime-unavailable"
        ? "telegram-control-failed"
        : "telegram-credential-unavailable",
  );
}

export function createTelegramControlCoordinator(
  input: CreateTelegramControlCoordinatorInput,
): TelegramControlCoordinator {
  let pending: Promise<void> = Promise.resolve();
  let cachedBot: TelegramBotState | undefined;

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation, operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const binding = (): TelegramDaemonBinding | undefined => {
    const selectedHome = input.selectedAthleteHome();
    const current = input.daemon.current();
    return current?.athleteHome === selectedHome ? current : undefined;
  };

  const isCurrent = (expected: TelegramDaemonBinding): boolean => {
    const current = input.daemon.current();
    return (
      current === expected &&
      current.generation === expected.generation &&
      current.athleteHome === input.selectedAthleteHome()
    );
  };

  const desired = async (): Promise<"disabled" | "enabled"> =>
    desiredFromRecord(await input.vault.desiredState());

  const vaultIdentity = async (): Promise<{
    readonly desiredState: "disabled" | "enabled";
    readonly credential: TelegramCredentialStatus;
    readonly metadata: TelegramBotMetadata;
  }> => ({
    desiredState: await desired(),
    credential: await input.vault.credentialStatus(),
    metadata: await input.vault.botMetadata(),
  });

  const project = async (
    daemonSnapshot?: TelegramControlSnapshot,
  ): Promise<DesktopTelegramSnapshot> => {
    const identity = await vaultIdentity();
    if (identity.credential.state === "wrong-home" || identity.metadata.state === "wrong-home") {
      return failure(identity.desiredState, "telegram-home-mismatch");
    }
    if (identity.credential.state === "re-prompt" || identity.metadata.state === "re-prompt") {
      return failure(identity.desiredState, "telegram-credential-unavailable");
    }
    const credentialConfigured = identity.credential.state === "configured";
    const metadataBot: TelegramBotState =
      identity.metadata.state === "configured"
        ? (cachedBot ?? { state: "ready", username: identity.metadata.username })
        : UNCONFIGURED_BOT;
    const bot =
      daemonSnapshot?.bot.state === "unconfigured" || daemonSnapshot === undefined
        ? metadataBot
        : daemonSnapshot.bot;
    const pairing = daemonSnapshot?.pairing ?? UNPAIRED;
    if (!credentialConfigured) {
      return {
        channel:
          identity.desiredState === "enabled"
            ? { desiredState: "enabled", state: "waiting-for-credential" }
            : DISABLED_CHANNEL,
        bot: UNCONFIGURED_BOT,
        pairing: UNPAIRED,
        credentialConfigured: false,
      };
    }
    const active = binding();
    if (active === undefined) {
      return failure(
        identity.desiredState,
        "telegram-daemon-unavailable",
        true,
        bot,
        pairing,
      );
    }
    if (identity.desiredState === "enabled" && active.supervision === "attached") {
      return {
        channel: { desiredState: "enabled", state: "transfer-required" },
        bot,
        pairing,
        credentialConfigured: true,
      };
    }
    return {
      channel:
        identity.desiredState === "disabled"
          ? DISABLED_CHANNEL
          : (daemonSnapshot?.channel ?? {
              desiredState: "enabled",
              state: "failed",
              errorCode: "telegram-control-failed",
            }),
      bot,
      pairing,
      credentialConfigured: true,
    };
  };

  const currentSnapshot = async (): Promise<DesktopTelegramSnapshot> => {
    const desiredState = await desired();
    const active = binding();
    if (active === undefined) return project();
    if (desiredState === "enabled" && active.supervision === "attached") return project();
    if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
    const response = await active.getTelegramStatus({});
    if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
    const parsed = parseSnapshot(response);
    return parsed === undefined
      ? failure(desiredState, "telegram-control-failed")
      : project(parsed);
  };

  const runSnapshot = (
    operation: () => Promise<DesktopTelegramSnapshot>,
  ): Promise<DesktopTelegramSnapshot> =>
    serialize(async () => {
      try {
        return await operation();
      } catch {
        let desiredState: "disabled" | "enabled" = "disabled";
        try {
          desiredState = await desired();
        } catch {}
        return failure(desiredState, "telegram-control-failed");
      }
    });

  const checkedBinding = async (): Promise<
    | { readonly active: TelegramDaemonBinding; readonly desiredState: "disabled" | "enabled" }
    | { readonly snapshot: DesktopTelegramSnapshot }
  > => {
    const desiredState = await desired();
    const active = binding();
    return active === undefined
      ? { snapshot: failure(desiredState, "telegram-daemon-unavailable") }
      : { active, desiredState };
  };

  const guardedSnapshotCall = async (
    active: TelegramDaemonBinding,
    invoke: () => Promise<unknown>,
  ): Promise<TelegramControlSnapshot | undefined> => {
    if (!isCurrent(active)) return undefined;
    const response = await invoke();
    if (!isCurrent(active)) return undefined;
    return parseSnapshot(response);
  };

  const inspect = async (
    active: TelegramDaemonBinding,
    token: string,
  ): Promise<TelegramCredentialInspection | undefined> => {
    if (!isCurrent(active)) return undefined;
    const response = await active.inspectTelegramCredential({ token });
    if (!isCurrent(active)) return undefined;
    return parseInspection(response);
  };

  const captureStoredToken = async (
    active: TelegramDaemonBinding,
  ): Promise<{ readonly token?: string; readonly result: TelegramCredentialApplyResult }> => {
    let token: string | undefined;
    const result = await input.vault.applyStoredCredential(active.athleteHome, async (value) => {
      token = value;
    });
    return { token, result };
  };

  const restoreMetadata = async (
    active: TelegramDaemonBinding,
    metadata: TelegramBotMetadata,
  ): Promise<void> => {
    if (metadata.state === "configured") {
      await input.vault.writeBotMetadata({
        username: metadata.username,
        authenticatedAthleteHome: active.athleteHome,
      });
      return;
    }
    await input.vault.deleteBotMetadata();
  };

  const persistCandidate = async (
    active: TelegramDaemonBinding,
    token: string,
    username: string,
  ): Promise<
    | {
        readonly status: "stored";
        readonly previousMetadata: TelegramBotMetadata;
        readonly previousToken?: string;
      }
    | { readonly status: "refused" }
  > => {
    const previousMetadata = await input.vault.botMetadata();
    if (previousMetadata.state === "wrong-home" || previousMetadata.state === "re-prompt") {
      return { status: "refused" };
    }
    const captured = await captureStoredToken(active);
    const previousToken = captured.result.status === "applied" ? captured.token : undefined;
    if (
      captured.result.status === "refused" &&
      captured.result.reason !== "missing"
    ) {
      return { status: "refused" };
    }
    const metadata = await input.vault.writeBotMetadata({
      username,
      authenticatedAthleteHome: active.athleteHome,
    });
    if (metadata.status !== "stored") return { status: "refused" };
    const credential = await input.vault.writeCredential({
      token,
      authenticatedAthleteHome: active.athleteHome,
    });
    if (credential.status !== "configured") {
      await restoreMetadata(active, previousMetadata);
      return { status: "refused" };
    }
    return {
      status: "stored",
      previousMetadata,
      ...(previousToken === undefined ? {} : { previousToken }),
    };
  };

  const rollbackCandidate = async (
    active: TelegramDaemonBinding,
    previous: Extract<Awaited<ReturnType<typeof persistCandidate>>, { status: "stored" }>,
  ): Promise<void> => {
    if (previous.previousToken === undefined) {
      await input.vault.deleteCredential();
      return;
    }
    await restoreMetadata(active, previous.previousMetadata);
    await input.vault.writeCredential({
      token: previous.previousToken,
      authenticatedAthleteHome: active.athleteHome,
    });
  };

  const configureCandidate = (
    token: string,
    replacement: boolean,
  ): Promise<DesktopTelegramSnapshot> =>
    runSnapshot(async () => {
      const checked = await checkedBinding();
      if ("snapshot" in checked) return checked.snapshot;
      const inspection = await inspect(checked.active, token);
      if (inspection === undefined) {
        return failure(checked.desiredState, "telegram-stale-operation");
      }
      if (inspection.status === "invalid-token" || inspection.status === "unavailable") {
        return currentSnapshot();
      }
      if (replacement && inspection.status === "webhook-removal-required") {
        return currentSnapshot();
      }
      const stored = await persistCandidate(
        checked.active,
        token,
        inspection.bot.username,
      );
      if (stored.status !== "stored") {
        return failure(checked.desiredState, "telegram-credential-storage-failed");
      }
      cachedBot = { state: inspection.status, username: inspection.bot.username };
      if (!replacement) {
        const desiredWrite = await input.vault.setDesiredState(false);
        if (desiredWrite.status !== "stored") {
          await rollbackCandidate(checked.active, stored);
          return failure("disabled", "telegram-credential-storage-failed");
        }
      }
      if (inspection.status === "webhook-removal-required") return project();
      if (checked.active.supervision === "attached") return project();
      const daemonSnapshot = await guardedSnapshotCall(checked.active, () =>
        replacement
          ? checked.active.replaceTelegram({ token })
          : checked.active.configureTelegram({ token }),
      );
      if (daemonSnapshot === undefined || daemonSnapshot.bot.state !== "ready") {
        await rollbackCandidate(checked.active, stored);
        return failure(checked.desiredState, "telegram-control-failed");
      }
      cachedBot = daemonSnapshot.bot;
      return project(daemonSnapshot);
    });

  const applyStored = async (
    active: TelegramDaemonBinding,
    operation: (token: string) => Promise<unknown>,
  ): Promise<TelegramControlSnapshot | DesktopTelegramSnapshot> => {
    let snapshot: TelegramControlSnapshot | undefined;
    let stale = false;
    const applied = await input.vault.applyStoredCredential(active.athleteHome, async (token) => {
      if (!isCurrent(active)) {
        stale = true;
        throw new TypeError();
      }
      const response = await operation(token);
      if (!isCurrent(active)) {
        stale = true;
        throw new TypeError();
      }
      snapshot = parseSnapshot(response);
      if (snapshot === undefined) throw new TypeError();
    });
    if (stale) return failure(await desired(), "telegram-stale-operation");
    return applied.status === "applied"
      ? (snapshot ?? failure(await desired(), "telegram-control-failed"))
      : credentialError(await desired(), applied);
  };

  return {
    configure: (token) => configureCandidate(token, false),
    replace: (token) => configureCandidate(token, true),

    enable() {
      return runSnapshot(async () => {
        const stored = await input.vault.setDesiredState(true);
        if (stored.status !== "stored") {
          return failure("enabled", "telegram-credential-storage-failed");
        }
        const active = binding();
        if (active === undefined) return failure("enabled", "telegram-daemon-unavailable");
        if (active.supervision === "attached") return project();
        const configured = await applyStored(active, (token) =>
          active.configureTelegram({ token }),
        );
        if ("credentialConfigured" in configured) return configured;
        if (configured.bot.state !== "ready") return project(configured);
        const enabled = await guardedSnapshotCall(active, () => active.enableTelegram({}));
        return enabled === undefined
          ? failure("enabled", "telegram-stale-operation")
          : project(enabled);
      });
    },

    disable() {
      return runSnapshot(async () => {
        const stored = await input.vault.setDesiredState(false);
        if (stored.status !== "stored") {
          return failure("disabled", "telegram-credential-storage-failed");
        }
        const active = binding();
        if (active === undefined) return failure("disabled", "telegram-daemon-unavailable");
        const disabled = await guardedSnapshotCall(active, () => active.disableTelegram({}));
        return disabled === undefined
          ? failure("disabled", "telegram-stale-operation")
          : project(disabled);
      });
    },

    stopPolling() {
      return runSnapshot(async () => {
        const desiredState = await desired();
        const active = binding();
        if (active === undefined) return failure(desiredState, "telegram-daemon-unavailable");
        const stopped = await guardedSnapshotCall(active, () => active.disableTelegram({}));
        return stopped === undefined
          ? failure(desiredState, "telegram-stale-operation")
          : project(stopped);
      });
    },

    remove() {
      return runSnapshot(async () => {
        const checked = await checkedBinding();
        if ("snapshot" in checked) return checked.snapshot;
        const disabled = await guardedSnapshotCall(checked.active, () =>
          checked.active.disableTelegram({}),
        );
        if (disabled === undefined || disabled.channel.state !== "disabled") {
          return failure(checked.desiredState, "telegram-drain-required", true);
        }
        const forgotten = await guardedSnapshotCall(checked.active, () =>
          checked.active.forgetTelegramCredential({}),
        );
        if (
          forgotten === undefined ||
          forgotten.channel.state !== "disabled" ||
          forgotten.bot.state !== "unconfigured"
        ) {
          return failure(checked.desiredState, "telegram-drain-required", true);
        }
        const desiredWrite = await input.vault.setDesiredState(false);
        if (desiredWrite.status !== "stored") {
          return failure("disabled", "telegram-credential-storage-failed", true);
        }
        const deleted = await input.vault.deleteCredential();
        if (deleted.status !== "deleted") {
          return failure(
            "disabled",
            deleted.reason === "wrong-home"
              ? "telegram-home-mismatch"
              : "telegram-credential-storage-failed",
            true,
          );
        }
        cachedBot = undefined;
        return project(forgotten);
      });
    },

    removeWebhook() {
      return runSnapshot(async () => {
        const checked = await checkedBinding();
        if ("snapshot" in checked) return checked.snapshot;
        let inspection: TelegramCredentialInspection | undefined;
        let storedToken: string | undefined;
        const applied = await input.vault.applyStoredCredential(
          checked.active.athleteHome,
          async (token) => {
            if (!isCurrent(checked.active)) throw new TypeError();
            const deleted = parseInspection(
              await checked.active.deleteTelegramWebhook({ token }),
            );
            if (deleted?.status !== "ready" || !isCurrent(checked.active)) throw new TypeError();
            inspection = parseInspection(
              await checked.active.inspectTelegramCredential({ token }),
            );
            if (inspection?.status !== "ready" || !isCurrent(checked.active)) {
              throw new TypeError();
            }
            storedToken = token;
          },
        );
        if (applied.status !== "applied") return credentialError(checked.desiredState, applied);
        if (inspection?.status !== "ready" || storedToken === undefined) {
          return failure(checked.desiredState, "telegram-control-failed", true);
        }
        const metadata = await input.vault.writeBotMetadata({
          username: inspection.bot.username,
          authenticatedAthleteHome: checked.active.athleteHome,
        });
        if (metadata.status !== "stored") {
          return failure(checked.desiredState, "telegram-credential-storage-failed", true);
        }
        cachedBot = { state: "ready", username: inspection.bot.username };
        if (checked.active.supervision === "app-supervised") {
          const configured = await guardedSnapshotCall(checked.active, () =>
            checked.active.configureTelegram({ token: storedToken! }),
          );
          if (configured?.bot.state !== "ready") {
            return failure(checked.desiredState, "telegram-control-failed", true, cachedBot);
          }
        }
        return currentSnapshot();
      });
    },

    status: () => runSnapshot(currentSnapshot),

    reconcile() {
      return runSnapshot(async () => {
        const desiredState = await desired();
        const active = binding();
        if (active === undefined) return failure(desiredState, "telegram-daemon-unavailable");
        if (desiredState === "disabled") {
          const disabled = await guardedSnapshotCall(active, () => active.disableTelegram({}));
          return disabled === undefined
            ? failure(desiredState, "telegram-stale-operation")
            : project(disabled);
        }
        if (active.supervision === "attached") return project();
        const configured = await applyStored(active, (token) =>
          active.configureTelegram({ token }),
        );
        if ("credentialConfigured" in configured) return configured;
        const reconciled = await guardedSnapshotCall(active, () => active.enableTelegram({}));
        return reconciled === undefined
          ? failure(desiredState, "telegram-stale-operation")
          : project(reconciled);
      });
    },

    beginPairing() {
      return runSnapshot(async () => {
        const checked = await checkedBinding();
        if ("snapshot" in checked) return checked.snapshot;
        if (checked.active.supervision === "attached") {
          const desiredWrite = await input.vault.setDesiredState(true);
          return desiredWrite.status === "stored"
            ? project()
            : failure("enabled", "telegram-credential-storage-failed", true);
        }
        const configured = await applyStored(checked.active, (token) =>
          checked.active.configureTelegram({ token }),
        );
        if ("credentialConfigured" in configured) return configured;
        if (configured.bot.state !== "ready") return project(configured);
        const pairing = await guardedSnapshotCall(checked.active, () =>
          checked.active.beginTelegramPairing({}),
        );
        if (pairing === undefined) return failure("enabled", "telegram-stale-operation", true);
        if (pairing.pairing.state === "awaiting-code" || pairing.pairing.state === "paired") {
          const desiredWrite = await input.vault.setDesiredState(true);
          if (desiredWrite.status !== "stored") {
            await checked.active.cancelTelegramPairing({});
            return failure("enabled", "telegram-credential-storage-failed", true);
          }
        }
        return project(pairing);
      });
    },

    cancelPairing() {
      return runSnapshot(async () => {
        const checked = await checkedBinding();
        if ("snapshot" in checked) return checked.snapshot;
        const cancelled = await guardedSnapshotCall(checked.active, () =>
          checked.active.cancelTelegramPairing({}),
        );
        if (cancelled === undefined) {
          return failure(checked.desiredState, "telegram-stale-operation", true);
        }
        if (cancelled.pairing.state !== "paired") {
          const stored = await input.vault.setDesiredState(false);
          if (stored.status !== "stored") {
            return failure("disabled", "telegram-credential-storage-failed", true);
          }
        }
        return project(cancelled);
      });
    },

    listAllowedSenders() {
      return serialize(async () => {
        const active = binding();
        if (active === undefined || !isCurrent(active)) return emptySenders();
        const response = await active.listTelegramAllowedSenders({});
        if (!isCurrent(active)) return emptySenders();
        const parsed = TelegramAllowedSendersResultSchema.safeParse(response);
        return parsed.success ? parsed.data : emptySenders();
      });
    },

    addAllowedSender(sender) {
      return serialize(async () => {
        const active = binding();
        if (active === undefined || !isCurrent(active)) return emptySenders();
        const response = await active.addTelegramAllowedSender(sender);
        if (!isCurrent(active)) return emptySenders();
        return TelegramAllowedSendersResultSchema.parse(response);
      });
    },

    removeAllowedSender(sender) {
      return serialize(async () => {
        const active = binding();
        if (active === undefined || !isCurrent(active)) return emptySenders();
        const response = await active.removeTelegramAllowedSender(sender);
        if (!isCurrent(active)) return emptySenders();
        return TelegramAllowedSendersResultSchema.parse(response);
      });
    },
  };
}
