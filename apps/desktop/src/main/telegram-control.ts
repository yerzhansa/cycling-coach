import type { AthleteHomeIdentity } from "@enduragent/coach-contract";
import type {
  TelegramCredentialApplyResult,
  TelegramCredentialStatus,
  TelegramCredentialVault,
  TelegramDesiredState,
} from "./telegram-credential-vault.js";

export const TELEGRAM_CONTROL_STATES = [
  "disabled",
  "waiting-for-credential",
  "starting",
  "online",
  "offline-retrying",
  "conflict",
  "invalid-token",
  "transfer-required",
  "failed",
] as const;

export type TelegramControlState = (typeof TELEGRAM_CONTROL_STATES)[number];
export type TelegramDesiredControlState = "disabled" | "enabled";

export const TELEGRAM_CONTROL_ERROR_CODES = [
  "telegram-invalid-token",
  "telegram-polling-conflict",
  "telegram-start-failed",
  "telegram-credential-storage-failed",
  "telegram-credential-unavailable",
  "telegram-daemon-unavailable",
  "telegram-home-mismatch",
  "telegram-stale-operation",
  "telegram-control-failed",
  "telegram-drain-required",
] as const;

export type TelegramControlErrorCode = (typeof TELEGRAM_CONTROL_ERROR_CODES)[number];

export interface TelegramControlStatus {
  readonly desiredState: TelegramDesiredControlState;
  readonly state: TelegramControlState;
  readonly botUsername?: string;
  readonly since?: string;
  readonly lastSuccessfulPollAt?: string;
  readonly retryCount?: number;
  readonly errorCode?: TelegramControlErrorCode;
}

type EmptyRpcParams = Readonly<Record<string, never>>;

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
}

export interface TelegramDaemonAuthorityPort {
  current(): TelegramDaemonBinding | undefined;
}

export interface TelegramControlCoordinator {
  configure(token: string): Promise<TelegramControlStatus>;
  enable(): Promise<TelegramControlStatus>;
  disable(): Promise<TelegramControlStatus>;
  replace(token: string): Promise<TelegramControlStatus>;
  remove(): Promise<TelegramControlStatus>;
  status(): Promise<TelegramControlStatus>;
  reconcile(): Promise<TelegramControlStatus>;
}

export interface CreateTelegramControlCoordinatorInput {
  readonly selectedAthleteHome: () => AthleteHomeIdentity;
  readonly vault: Pick<
    TelegramCredentialVault,
    | "credentialStatus"
    | "writeCredential"
    | "applyStoredCredential"
    | "deleteCredential"
    | "desiredState"
    | "setDesiredState"
  >;
  readonly daemon: TelegramDaemonAuthorityPort;
}

const ERROR_CODES = new Set<string>(TELEGRAM_CONTROL_ERROR_CODES);
const STATES = new Set<string>(TELEGRAM_CONTROL_STATES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeBotUsername(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.startsWith("@") ? value.slice(1) : value;
  return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(normalized) ? normalized : undefined;
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function safeRetryCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000
    ? (value as number)
    : undefined;
}

function failure(
  desiredState: TelegramDesiredControlState,
  errorCode: TelegramControlErrorCode,
): TelegramControlStatus {
  return { desiredState, state: "failed", errorCode };
}

function sanitizeDaemonStatus(
  value: unknown,
  desiredState: TelegramDesiredControlState,
): TelegramControlStatus {
  if (!isRecord(value) || typeof value.state !== "string" || !STATES.has(value.state)) {
    return failure(desiredState, "telegram-control-failed");
  }
  const status: {
    desiredState: TelegramDesiredControlState;
    state: TelegramControlState;
    botUsername?: string;
    since?: string;
    lastSuccessfulPollAt?: string;
    retryCount?: number;
    errorCode?: TelegramControlErrorCode;
  } = {
    desiredState:
      value.desiredState === "enabled" || value.desiredState === "disabled"
        ? value.desiredState
        : desiredState,
    state: value.state as TelegramControlState,
  };
  const botUsername = safeBotUsername(value.botUsername);
  const since = safeTimestamp(value.since);
  const lastSuccessfulPollAt = safeTimestamp(value.lastSuccessfulPollAt);
  const retryCount = safeRetryCount(value.retryCount);
  if (botUsername !== undefined) status.botUsername = botUsername;
  if (since !== undefined) status.since = since;
  if (lastSuccessfulPollAt !== undefined) status.lastSuccessfulPollAt = lastSuccessfulPollAt;
  if (retryCount !== undefined) status.retryCount = retryCount;
  if (typeof value.errorCode === "string" && ERROR_CODES.has(value.errorCode)) {
    status.errorCode = value.errorCode as TelegramControlErrorCode;
  }
  return status;
}

function desiredFromRecord(value: TelegramDesiredState): TelegramDesiredControlState {
  return value.state === "configured" && value.enabled ? "enabled" : "disabled";
}

function credentialFailure(
  desiredState: TelegramDesiredControlState,
  result: TelegramCredentialApplyResult,
): TelegramControlStatus {
  if (result.status === "applied") throw new TypeError("credential was applied");
  if (result.reason === "missing" && desiredState === "enabled") {
    return { desiredState, state: "waiting-for-credential" };
  }
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

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const desired = async (): Promise<TelegramDesiredControlState> =>
    desiredFromRecord(await input.vault.desiredState());

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

  const applyStored = async (
    active: TelegramDaemonBinding,
    desiredState: TelegramDesiredControlState,
    operation: (token: string) => Promise<unknown>,
  ): Promise<TelegramControlStatus> => {
    let result: TelegramControlStatus | undefined;
    let guardFailure: TelegramControlErrorCode | undefined;
    const applied = await input.vault.applyStoredCredential(active.athleteHome, async (token) => {
      if (!isCurrent(active)) {
        guardFailure = "telegram-stale-operation";
        throw new TypeError();
      }
      const response = await operation(token);
      if (!isCurrent(active)) {
        guardFailure = "telegram-stale-operation";
        throw new TypeError();
      }
      result = sanitizeDaemonStatus(response, desiredState);
    });
    if (guardFailure !== undefined) return failure(desiredState, guardFailure);
    return applied.status === "applied"
      ? (result ?? failure(desiredState, "telegram-control-failed"))
      : credentialFailure(desiredState, applied);
  };

  const run = (operation: () => Promise<TelegramControlStatus>): Promise<TelegramControlStatus> =>
    serialize(async () => {
      try {
        return await operation();
      } catch {
        let desiredState: TelegramDesiredControlState = "disabled";
        try {
          desiredState = await desired();
        } catch {}
        return failure(desiredState, "telegram-control-failed");
      }
    });

  const checkedBinding = async (): Promise<
    | { readonly active: TelegramDaemonBinding; readonly desiredState: TelegramDesiredControlState }
    | { readonly status: TelegramControlStatus }
  > => {
    const desiredState = await desired();
    const active = binding();
    return active === undefined
      ? { status: failure(desiredState, "telegram-daemon-unavailable") }
      : { active, desiredState };
  };

  return {
    configure(token) {
      return run(async () => {
        const checked = await checkedBinding();
        if ("status" in checked) return checked.status;
        const written = await input.vault.writeCredential({
          token,
          authenticatedAthleteHome: checked.active.athleteHome,
        });
        if (written.status !== "configured") {
          return failure(
            checked.desiredState,
            written.reason === "wrong-home"
              ? "telegram-home-mismatch"
              : "telegram-credential-storage-failed",
          );
        }
        return applyStored(checked.active, checked.desiredState, (storedToken) =>
          checked.active.configureTelegram({ token: storedToken }),
        );
      });
    },

    enable() {
      return run(async () => {
        const stored = await input.vault.setDesiredState(true);
        if (stored.status !== "stored") {
          return failure("enabled", "telegram-credential-storage-failed");
        }
        const active = binding();
        if (active === undefined) return failure("enabled", "telegram-daemon-unavailable");
        if (active.supervision !== "app-supervised") {
          return { desiredState: "enabled", state: "transfer-required" };
        }
        const configured = await applyStored(active, "enabled", (token) =>
          active.configureTelegram({ token }),
        );
        if (!(["disabled", "starting", "online"] as const).includes(configured.state as never)) {
          return configured;
        }
        if (!isCurrent(active)) return failure("enabled", "telegram-stale-operation");
        const enabled = await active.enableTelegram({});
        if (!isCurrent(active)) return failure("enabled", "telegram-stale-operation");
        return sanitizeDaemonStatus(enabled, "enabled");
      });
    },

    disable() {
      return run(async () => {
        const stored = await input.vault.setDesiredState(false);
        if (stored.status !== "stored") {
          return failure("disabled", "telegram-credential-storage-failed");
        }
        const active = binding();
        if (active === undefined) return failure("disabled", "telegram-daemon-unavailable");
        if (!isCurrent(active)) return failure("disabled", "telegram-stale-operation");
        const disabled = await active.disableTelegram({});
        if (!isCurrent(active)) return failure("disabled", "telegram-stale-operation");
        return sanitizeDaemonStatus(disabled, "disabled");
      });
    },

    replace(token) {
      return run(async () => {
        const checked = await checkedBinding();
        if ("status" in checked) return checked.status;
        const written = await input.vault.writeCredential({
          token,
          authenticatedAthleteHome: checked.active.athleteHome,
        });
        if (written.status !== "configured") {
          return failure(
            checked.desiredState,
            written.reason === "wrong-home"
              ? "telegram-home-mismatch"
              : "telegram-credential-storage-failed",
          );
        }
        return applyStored(checked.active, checked.desiredState, (storedToken) =>
          checked.active.replaceTelegram({ token: storedToken }),
        );
      });
    },

    remove() {
      return run(async () => {
        const desiredState = await desired();
        const state = await input.vault.credentialStatus();
        if (state.state === "missing") {
          return desiredState === "enabled"
            ? { desiredState, state: "waiting-for-credential" }
            : { desiredState, state: "disabled" };
        }
        if (state.state === "wrong-home") {
          return failure(desiredState, "telegram-home-mismatch");
        }
        if (state.state !== "configured") {
          return failure(desiredState, "telegram-credential-unavailable");
        }
        const active = binding();
        if (active === undefined) {
          return failure(desiredState, "telegram-daemon-unavailable");
        }
        if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
        const disabled = sanitizeDaemonStatus(await active.disableTelegram({}), "disabled");
        if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
        if (disabled.state !== "disabled") {
          return failure(desiredState, "telegram-drain-required");
        }
        const deleted = await input.vault.deleteCredential();
        if (deleted.status !== "deleted") {
          return failure(
            desiredState,
            deleted.reason === "wrong-home"
              ? "telegram-home-mismatch"
              : "telegram-credential-storage-failed",
          );
        }
        return desiredState === "enabled"
          ? { desiredState, state: "waiting-for-credential" }
          : { desiredState, state: "disabled" };
      });
    },

    status() {
      return run(async () => {
        const desiredState = await desired();
        const credential: TelegramCredentialStatus = await input.vault.credentialStatus();
        if (desiredState === "enabled" && credential.state === "missing") {
          return { desiredState, state: "waiting-for-credential" };
        }
        if (credential.state === "wrong-home") {
          return failure(desiredState, "telegram-home-mismatch");
        }
        if (credential.state === "re-prompt") {
          return failure(desiredState, "telegram-credential-unavailable");
        }
        const active = binding();
        if (active === undefined) {
          return failure(desiredState, "telegram-daemon-unavailable");
        }
        if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
        const current = await active.getTelegramStatus({});
        if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
        return sanitizeDaemonStatus(current, desiredState);
      });
    },

    reconcile() {
      return run(async () => {
        const desiredState = await desired();
        const active = binding();
        if (active === undefined) {
          return failure(desiredState, "telegram-daemon-unavailable");
        }
        if (desiredState === "disabled") {
          if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
          const disabled = await active.disableTelegram({});
          if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
          return sanitizeDaemonStatus(disabled, desiredState);
        }
        if (active.supervision !== "app-supervised") {
          return { desiredState, state: "transfer-required" };
        }
        const configured = await applyStored(active, desiredState, (token) =>
          active.configureTelegram({ token }),
        );
        if (!(["disabled", "starting", "online"] as const).includes(configured.state as never)) {
          return configured;
        }
        if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
        const reconciled = await active.reconcileTelegram({});
        if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
        return sanitizeDaemonStatus(reconciled, desiredState);
      });
    },
  };
}
