import {
  addSecondarySender,
  claimPrimaryOperator,
  deleteTelegramWebhook as deleteCoreTelegramWebhook,
  inspectTelegramCredential as inspectCoreTelegramCredential,
  listDesktopAllowedSenders,
  removeSecondarySender,
} from "@enduragent/core";
import type {
  TelegramAllowedSendersResult,
  TelegramBotState,
  TelegramChannelStatus,
  TelegramControlSnapshot,
  TelegramCredentialInspection,
  TelegramPairingState,
} from "@enduragent/coach-contract";
import {
  createDesktopTelegramPairing,
  type DesktopPrimaryOperatorClaimResult,
  type DesktopTelegramPairingCoordinator,
} from "./desktop-telegram-pairing.js";

export interface DesktopTelegramRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  drainPending(): Promise<void>;
}

export interface DesktopTelegramRuntimeFactoryInput {
  readonly token: string;
  readonly onStarted: () => void;
  readonly onPollingSuccess: () => void;
  readonly onPollingFailure: () => void;
  readonly consumePairing: (input: {
    readonly senderId: string;
    readonly senderName: string | undefined;
    readonly messageText: string;
  }) => Promise<boolean>;
}

export type DesktopTelegramControllerStatus = TelegramControlSnapshot;

export interface DesktopTelegramController {
  getStatus(): TelegramControlSnapshot;
  configure(token: string): Promise<TelegramControlSnapshot>;
  enable(): Promise<TelegramControlSnapshot>;
  disable(): Promise<TelegramControlSnapshot>;
  replace(token: string): Promise<TelegramControlSnapshot>;
  reconcile(): Promise<TelegramControlSnapshot>;
  inspectTelegramCredential(token: string): Promise<TelegramCredentialInspection>;
  deleteTelegramWebhook(token: string): Promise<TelegramCredentialInspection>;
  forgetTelegramCredential(): Promise<TelegramControlSnapshot>;
  beginTelegramPairing(): Promise<TelegramControlSnapshot>;
  cancelTelegramPairing(): Promise<TelegramControlSnapshot>;
  listTelegramAllowedSenders(): Promise<TelegramAllowedSendersResult>;
  addTelegramAllowedSender(senderId: number): Promise<TelegramAllowedSendersResult>;
  removeTelegramAllowedSender(senderId: number): Promise<TelegramAllowedSendersResult>;
  stopPolling(): Promise<TelegramControlSnapshot>;
  resumePolling(): Promise<TelegramControlSnapshot>;
  drainPending(): Promise<TelegramControlSnapshot>;
  close(): Promise<TelegramControlSnapshot>;
}

export interface CreateDesktopTelegramControllerInput {
  readonly dataDir: string;
  readonly createRuntime: (input: DesktopTelegramRuntimeFactoryInput) => DesktopTelegramRuntime;
}

interface DesktopSenderRecord {
  readonly senderId: string;
  readonly role: "primary" | "additional";
  readonly addedAt?: string;
}

interface SecondarySenderMutationResult {
  readonly status: "added" | "already-allowed" | "removed" | "not-found" | "refused";
  readonly reason?: string;
}

export interface DesktopTelegramControllerDependencies {
  readonly inspectTelegramCredential?: (token: string) => Promise<TelegramCredentialInspection>;
  readonly deleteTelegramWebhook?: (token: string) => Promise<TelegramCredentialInspection>;
  readonly claimPrimaryOperator?: (
    dataDir: string,
    senderId: string,
  ) => DesktopPrimaryOperatorClaimResult;
  readonly listDesktopAllowedSenders?: (dataDir: string) => readonly DesktopSenderRecord[];
  readonly addSecondarySender?: (
    dataDir: string,
    senderId: string,
  ) => SecondarySenderMutationResult;
  readonly removeSecondarySender?: (
    dataDir: string,
    senderId: string,
  ) => SecondarySenderMutationResult;
  readonly createPairing?: typeof createDesktopTelegramPairing;
  readonly pairingRandomBytes?: (size: number) => Uint8Array;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void;
}

interface ActiveRuntime {
  readonly generation: number;
  readonly runtime: DesktopTelegramRuntime;
  attempt: number;
  pollingState: "running" | "paused";
  transportOnline: boolean;
  restartBlocked: boolean;
  stopTask?: Promise<void>;
  drainTask?: Promise<void>;
}

const DISABLED_STATUS = Object.freeze({
  desiredState: "disabled",
  state: "disabled",
} as const);
const WAITING_FOR_CREDENTIAL_STATUS = Object.freeze({
  desiredState: "enabled",
  state: "waiting-for-credential",
} as const);
const STARTING_STATUS = Object.freeze({
  desiredState: "enabled",
  state: "starting",
} as const);
const ONLINE_STATUS = Object.freeze({
  desiredState: "enabled",
  state: "online",
} as const);
const OFFLINE_RETRYING_STATUS = Object.freeze({
  desiredState: "enabled",
  state: "offline-retrying",
} as const);
const INVALID_TOKEN_STATUS = Object.freeze({
  desiredState: "enabled",
  errorCode: "telegram-invalid-token",
  state: "invalid-token",
} as const);
const CONFLICT_STATUS = Object.freeze({
  desiredState: "enabled",
  errorCode: "telegram-polling-conflict",
  state: "conflict",
} as const);
const FAILED_STATUS = Object.freeze({
  desiredState: "enabled",
  errorCode: "telegram-start-failed",
  state: "failed",
} as const);
const UNCONFIGURED_BOT = Object.freeze({ state: "unconfigured" } as const);
const PAIRED = Object.freeze({ state: "paired" } as const);
const INSPECTION_UNAVAILABLE = Object.freeze({
  status: "unavailable",
  errorCode: "telegram-validation-failed",
} as const);

function telegramErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("error_code" in error)) return undefined;
  const value = error.error_code;
  return typeof value === "number" ? value : undefined;
}

function canonicalTimestamp(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 40) return undefined;
  try {
    return new Date(value).toISOString() === value ? value : undefined;
  } catch {
    return undefined;
  }
}

class DefaultDesktopTelegramController implements DesktopTelegramController {
  private channel: TelegramChannelStatus = DISABLED_STATUS;
  private bot: TelegramBotState = UNCONFIGURED_BOT;
  private configuredToken: string | undefined;
  private desiredEnabled = false;
  private pollingSuspended = false;
  private generation = 0;
  private active: ActiveRuntime | undefined;
  private mutationTail: Promise<void> = Promise.resolve();
  private primaryPresent = false;
  private pairingPolling = false;
  private pairingFailure: TelegramPairingState | undefined;
  private pairingExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pairing: DesktopTelegramPairingCoordinator;

  constructor(
    private readonly input: CreateDesktopTelegramControllerInput,
    private readonly dependencies: Required<
      Omit<
        DesktopTelegramControllerDependencies,
        "pairingRandomBytes" | "now" | "schedule" | "cancelSchedule"
      >
    > &
      Pick<
        DesktopTelegramControllerDependencies,
        "pairingRandomBytes" | "now" | "schedule" | "cancelSchedule"
      >,
  ) {
    this.refreshPrimary();
    this.pairing = dependencies.createPairing({
      claimPrimaryOperator: (senderId) =>
        dependencies.claimPrimaryOperator(input.dataDir, senderId),
      hasPrimaryOperator: () =>
        dependencies
          .listDesktopAllowedSenders(input.dataDir)
          .some((sender) => sender.role === "primary"),
      ...(dependencies.pairingRandomBytes === undefined
        ? {}
        : { randomBytes: dependencies.pairingRandomBytes }),
      ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    });
  }

  getStatus(): TelegramControlSnapshot {
    return this.snapshot();
  }

  configure(token: string): Promise<TelegramControlSnapshot> {
    return this.serialize(async () => {
      if (this.configuredToken !== undefined) return this.snapshot();
      const inspection = await this.inspect(token);
      if (inspection.status === "ready" || inspection.status === "webhook-removal-required") {
        this.configuredToken = token;
        this.bot = {
          state: inspection.status,
          username: inspection.bot.username,
        };
        await this.reconcileUnlocked();
      } else if (this.desiredEnabled) {
        this.channel = inspection.status === "invalid-token" ? INVALID_TOKEN_STATUS : FAILED_STATUS;
      }
      return this.snapshot();
    });
  }

  enable(): Promise<TelegramControlSnapshot> {
    return this.serialize(async () => {
      this.refreshPrimary();
      if (!this.primaryPresent && !this.pairingPolling) return this.snapshot();
      this.desiredEnabled = true;
      await this.reconcileUnlocked();
      return this.snapshot();
    });
  }

  disable(): Promise<TelegramControlSnapshot> {
    return this.serialize(() => this.disableUnlocked());
  }

  replace(token: string): Promise<TelegramControlSnapshot> {
    return this.serialize(async () => {
      const inspection = await this.inspect(token);
      if (inspection.status !== "ready") return this.snapshot();

      this.cancelPairingWindow();
      if (!this.primaryPresent) this.desiredEnabled = false;
      const previous = this.invalidateActive();
      if (previous !== undefined) {
        await this.stopRuntime(previous);
        await this.drainRuntime(previous);
        if (this.active === previous) this.active = undefined;
      }
      this.configuredToken = token;
      this.bot = { state: inspection.status, username: inspection.bot.username };
      await this.reconcileUnlocked();
      return this.snapshot();
    });
  }

  reconcile(): Promise<TelegramControlSnapshot> {
    return this.serialize(async () => {
      this.refreshPrimary();
      await this.reconcileUnlocked();
      return this.snapshot();
    });
  }

  inspectTelegramCredential(token: string): Promise<TelegramCredentialInspection> {
    return this.inspect(token);
  }

  deleteTelegramWebhook(token: string): Promise<TelegramCredentialInspection> {
    return this.serialize(async () => {
      let inspection: TelegramCredentialInspection;
      try {
        inspection = await this.dependencies.deleteTelegramWebhook(token);
      } catch {
        inspection = INSPECTION_UNAVAILABLE;
      }
      if (
        this.configuredToken === token &&
        (inspection.status === "ready" || inspection.status === "webhook-removal-required")
      ) {
        this.bot = { state: inspection.status, username: inspection.bot.username };
        await this.reconcileUnlocked();
      }
      return inspection;
    });
  }

  forgetTelegramCredential(): Promise<TelegramControlSnapshot> {
    return this.serialize(async () => {
      this.cancelPairingWindow();
      this.desiredEnabled = false;
      this.channel = DISABLED_STATUS;
      const previous = this.invalidateActive();
      if (previous !== undefined) {
        await this.stopRuntime(previous);
        await this.drainRuntime(previous);
        if (this.active === previous) this.active = undefined;
      }
      this.configuredToken = undefined;
      this.bot = UNCONFIGURED_BOT;
      return this.snapshot();
    });
  }

  beginTelegramPairing(): Promise<TelegramControlSnapshot> {
    return this.serialize(async () => {
      this.refreshPrimary();
      this.desiredEnabled = true;
      if (this.primaryPresent) {
        await this.reconcileUnlocked();
        return this.snapshot();
      }
      if (this.configuredToken === undefined || this.bot.state !== "ready") {
        this.pairingFailure = {
          state: "failed",
          errorCode: "telegram-pairing-unavailable",
        };
        this.channel =
          this.configuredToken === undefined ? WAITING_FOR_CREDENTIAL_STATUS : CONFLICT_STATUS;
        return this.snapshot();
      }
      this.pairingFailure = undefined;
      const pairing = this.pairing.begin();
      if (pairing.state !== "awaiting-code") {
        this.channel = FAILED_STATUS;
        return this.snapshot();
      }
      this.pairingPolling = true;
      this.schedulePairingExpiry(pairing);
      await this.reconcileUnlocked();
      return this.snapshot();
    });
  }

  cancelTelegramPairing(): Promise<TelegramControlSnapshot> {
    return this.serialize(() => this.cancelPairingUnlocked());
  }

  async listTelegramAllowedSenders(): Promise<TelegramAllowedSendersResult> {
    return this.senderList();
  }

  addTelegramAllowedSender(senderId: number): Promise<TelegramAllowedSendersResult> {
    return this.serialize(async () => {
      const result = this.dependencies.addSecondarySender(this.input.dataDir, String(senderId));
      if (result.status === "refused") throw new TypeError("Telegram sender addition was refused");
      this.refreshPrimary();
      return this.senderList();
    });
  }

  removeTelegramAllowedSender(senderId: number): Promise<TelegramAllowedSendersResult> {
    return this.serialize(async () => {
      const result = this.dependencies.removeSecondarySender(this.input.dataDir, String(senderId));
      if (result.status === "refused") throw new TypeError("Telegram sender removal was refused");
      this.refreshPrimary();
      return this.senderList();
    });
  }

  stopPolling(): Promise<TelegramControlSnapshot> {
    this.pollingSuspended = true;
    return this.serialize(async () => {
      const active = this.active;
      if (active !== undefined && active.pollingState === "running") {
        this.channel = this.desiredEnabled ? STARTING_STATUS : DISABLED_STATUS;
        await this.pauseRuntime(active);
      } else if (this.desiredEnabled && this.configuredToken !== undefined) {
        this.channel = STARTING_STATUS;
      }
      return this.snapshot();
    });
  }

  resumePolling(): Promise<TelegramControlSnapshot> {
    return this.serialize(async () => {
      this.pollingSuspended = false;
      await this.reconcileUnlocked();
      return this.snapshot();
    });
  }

  drainPending(): Promise<TelegramControlSnapshot> {
    return this.serialize(async () => {
      const active = this.active;
      if (active !== undefined) await this.drainRuntime(active);
      return this.snapshot();
    });
  }

  close(): Promise<TelegramControlSnapshot> {
    return this.serialize(() => this.disableUnlocked());
  }

  private snapshot(): TelegramControlSnapshot {
    const pairing = this.primaryPresent ? PAIRED : (this.pairingFailure ?? this.pairing.getState());
    return {
      channel: this.channel,
      bot: this.bot,
      pairing,
    };
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutationTail.then(operation, operation);
    this.mutationTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async inspect(token: string): Promise<TelegramCredentialInspection> {
    try {
      return await this.dependencies.inspectTelegramCredential(token);
    } catch {
      return INSPECTION_UNAVAILABLE;
    }
  }

  private async disableUnlocked(): Promise<TelegramControlSnapshot> {
    this.cancelPairingWindow();
    this.desiredEnabled = false;
    this.channel = DISABLED_STATUS;
    const previous = this.invalidateActive();
    if (previous !== undefined) {
      await this.stopRuntime(previous);
      await this.drainRuntime(previous);
      if (this.active === previous) this.active = undefined;
    }
    return this.snapshot();
  }

  private cancelPairingWindow(): void {
    this.clearPairingExpiry();
    this.pairingPolling = false;
    this.pairingFailure = undefined;
    this.pairing.cancel();
  }

  private clearPairingExpiry(): void {
    const timer = this.pairingExpiryTimer;
    if (timer === undefined) return;
    this.pairingExpiryTimer = undefined;
    (this.dependencies.cancelSchedule ?? clearTimeout)(timer);
  }

  private schedulePairingExpiry(
    pairing: Extract<TelegramPairingState, { state: "awaiting-code" }>,
  ): void {
    this.clearPairingExpiry();
    const now = this.dependencies.now ?? Date.now;
    const delayMs = Math.max(0, Date.parse(pairing.expiresAt) - now());
    const schedule = this.dependencies.schedule ?? setTimeout;
    const timer = schedule(() => {
      if (this.pairingExpiryTimer !== timer) return;
      this.pairingExpiryTimer = undefined;
      void this.serialize(() => this.expirePairingUnlocked());
    }, delayMs);
    timer.unref?.();
    this.pairingExpiryTimer = timer;
  }

  private async expirePairingUnlocked(): Promise<TelegramControlSnapshot> {
    if (
      this.primaryPresent ||
      !this.pairingPolling ||
      this.pairing.getState().state !== "expired"
    ) {
      return this.snapshot();
    }
    this.pairingPolling = false;
    this.desiredEnabled = false;
    this.channel = DISABLED_STATUS;
    const previous = this.invalidateActive();
    if (previous !== undefined) {
      await this.stopRuntime(previous);
      await this.drainRuntime(previous);
      if (this.active === previous) this.active = undefined;
    }
    return this.snapshot();
  }

  private async cancelPairingUnlocked(): Promise<TelegramControlSnapshot> {
    const shouldStopPreOwnershipPoller = this.pairingPolling && !this.primaryPresent;
    this.cancelPairingWindow();
    if (!shouldStopPreOwnershipPoller) return this.snapshot();
    this.desiredEnabled = false;
    this.channel = DISABLED_STATUS;
    const previous = this.invalidateActive();
    if (previous !== undefined) {
      await this.stopRuntime(previous);
      await this.drainRuntime(previous);
      if (this.active === previous) this.active = undefined;
    }
    return this.snapshot();
  }

  private async reconcileUnlocked(): Promise<void> {
    if (!this.desiredEnabled) {
      this.channel = DISABLED_STATUS;
      return;
    }
    if (this.configuredToken === undefined) {
      this.channel = WAITING_FOR_CREDENTIAL_STATUS;
      return;
    }
    if (this.bot.state === "webhook-removal-required") {
      this.channel = CONFLICT_STATUS;
      return;
    }
    if (this.bot.state !== "ready") {
      this.channel = FAILED_STATUS;
      return;
    }
    if (!this.primaryPresent && !this.pairingPolling) {
      this.desiredEnabled = false;
      this.channel = DISABLED_STATUS;
      return;
    }
    const active = this.active;
    if (this.pollingSuspended) {
      if (active !== undefined && active.pollingState === "running")
        await this.pauseRuntime(active);
      this.channel = STARTING_STATUS;
      return;
    }
    if (active === undefined) {
      await this.startConfiguredRuntime();
      return;
    }
    if (active.pollingState === "paused" && !active.restartBlocked) {
      this.resumeRuntime(active);
      return;
    }
    if (active.transportOnline) {
      this.channel = this.primaryPresent ? ONLINE_STATUS : STARTING_STATUS;
    }
  }

  private async startConfiguredRuntime(): Promise<void> {
    const token = this.configuredToken;
    if (
      !this.desiredEnabled ||
      (!this.primaryPresent && !this.pairingPolling) ||
      token === undefined ||
      this.bot.state !== "ready"
    ) {
      return;
    }
    if (this.pollingSuspended) {
      this.channel = STARTING_STATUS;
      return;
    }
    const generation = ++this.generation;
    this.channel = STARTING_STATUS;
    let runtime: DesktopTelegramRuntime;
    try {
      runtime = this.input.createRuntime({
        token,
        onStarted: () => this.reportTransportStarted(generation),
        onPollingSuccess: () => this.reportPollingSuccess(generation),
        onPollingFailure: () => this.reportPollingFailure(generation),
        consumePairing: (pairingInput) => this.consumePairing(generation, pairingInput),
      });
    } catch {
      if (this.isCurrent(generation)) this.channel = FAILED_STATUS;
      return;
    }
    const active: ActiveRuntime = {
      generation,
      runtime,
      attempt: 0,
      pollingState: "running",
      transportOnline: false,
      restartBlocked: false,
    };
    this.active = active;
    this.startRuntime(active);
  }

  private async consumePairing(
    generation: number,
    input: { readonly senderId: string; readonly messageText: string },
  ): Promise<boolean> {
    if (!this.isCurrent(generation)) return false;
    const consumed = this.pairing.consumePrivateMessage(input);
    if (!consumed) return false;
    this.refreshPrimary();
    if (this.pairing.getState().state === "paired" || this.primaryPresent) {
      this.primaryPresent = true;
      this.pairingPolling = false;
      this.clearPairingExpiry();
      const active = this.active;
      if (active?.generation === generation && active.transportOnline) this.channel = ONLINE_STATUS;
    }
    return true;
  }

  private invalidateActive(): ActiveRuntime | undefined {
    this.generation += 1;
    const active = this.active;
    if (active !== undefined) {
      active.attempt += 1;
      active.pollingState = "paused";
      active.transportOnline = false;
    }
    return active;
  }

  private async pauseRuntime(active: ActiveRuntime): Promise<void> {
    active.attempt += 1;
    active.pollingState = "paused";
    active.transportOnline = false;
    await this.stopRuntime(active);
  }

  private resumeRuntime(active: ActiveRuntime): void {
    active.stopTask = undefined;
    active.drainTask = undefined;
    active.pollingState = "running";
    active.transportOnline = false;
    active.restartBlocked = false;
    this.channel = STARTING_STATUS;
    this.startRuntime(active);
  }

  private isCurrent(generation: number): boolean {
    return this.desiredEnabled && this.generation === generation;
  }

  private reportTransportStarted(generation: number): void {
    const active = this.active;
    if (
      this.isCurrent(generation) &&
      active?.generation === generation &&
      active.pollingState === "running" &&
      !active.restartBlocked &&
      !this.pollingSuspended
    ) {
      this.channel = STARTING_STATUS;
    }
  }

  private reportPollingSuccess(generation: number): void {
    const active = this.active;
    if (
      this.isCurrent(generation) &&
      active?.generation === generation &&
      active.pollingState === "running" &&
      !active.restartBlocked &&
      !this.pollingSuspended
    ) {
      active.transportOnline = true;
      this.channel = this.primaryPresent ? ONLINE_STATUS : STARTING_STATUS;
    }
  }

  private reportPollingFailure(generation: number): void {
    const active = this.active;
    if (
      this.isCurrent(generation) &&
      active?.generation === generation &&
      active.pollingState === "running" &&
      !active.restartBlocked &&
      !this.pollingSuspended
    ) {
      active.transportOnline = false;
      this.channel = OFFLINE_RETRYING_STATUS;
    }
  }

  private startRuntime(active: ActiveRuntime): void {
    const attempt = ++active.attempt;
    let startTask: Promise<void>;
    try {
      startTask = Promise.resolve(active.runtime.start());
    } catch (error) {
      this.handleStartRejection(active, attempt, error);
      return;
    }
    void startTask.then(
      () => this.handleStartCompletion(active, attempt),
      (error: unknown) => this.handleStartRejection(active, attempt, error),
    );
  }

  private handleStartCompletion(active: ActiveRuntime, attempt: number): void {
    if (!this.isAttemptActive(active, attempt)) return;
    active.pollingState = "paused";
    active.transportOnline = false;
    active.restartBlocked = true;
    this.channel = FAILED_STATUS;
  }

  private handleStartRejection(active: ActiveRuntime, attempt: number, error: unknown): void {
    if (!this.isAttemptActive(active, attempt)) return;
    active.pollingState = "paused";
    active.transportOnline = false;
    active.restartBlocked = true;
    const errorCode = telegramErrorCode(error);
    this.channel =
      errorCode === 401
        ? INVALID_TOKEN_STATUS
        : errorCode === 409
          ? CONFLICT_STATUS
          : FAILED_STATUS;
  }

  private isAttemptActive(active: ActiveRuntime, attempt: number): boolean {
    return (
      this.active === active &&
      this.isCurrent(active.generation) &&
      active.pollingState === "running" &&
      active.attempt === attempt
    );
  }

  private stopRuntime(active: ActiveRuntime): Promise<void> {
    active.stopTask ??= Promise.resolve()
      .then(() => active.runtime.stop())
      .catch(() => undefined);
    return active.stopTask;
  }

  private drainRuntime(active: ActiveRuntime): Promise<void> {
    active.drainTask ??= Promise.resolve()
      .then(() => active.runtime.drainPending())
      .catch(() => undefined);
    return active.drainTask;
  }

  private refreshPrimary(): void {
    try {
      this.primaryPresent = this.dependencies
        .listDesktopAllowedSenders(this.input.dataDir)
        .some((sender) => sender.role === "primary");
    } catch {
      this.primaryPresent = false;
    }
  }

  private senderList(): TelegramAllowedSendersResult {
    const records = this.dependencies.listDesktopAllowedSenders(this.input.dataDir);
    if (records.length > 1_000) throw new TypeError("Telegram sender state is inconsistent");
    const seen = new Set<number>();
    const senders = records.map((sender) => {
      const senderId = Number(sender.senderId);
      const addedAt = canonicalTimestamp(sender.addedAt);
      if (
        !Number.isSafeInteger(senderId) ||
        senderId < 10 ||
        seen.has(senderId) ||
        (sender.addedAt !== undefined && addedAt === undefined)
      ) {
        throw new TypeError("Telegram sender state is inconsistent");
      }
      seen.add(senderId);
      return {
        senderId,
        role: sender.role,
        ...(addedAt === undefined ? {} : { addedAt }),
      };
    });
    const primaryCount = senders.filter((sender) => sender.role === "primary").length;
    if (primaryCount > 1 || (senders.length > 0 && primaryCount !== 1)) {
      throw new TypeError("Telegram sender state is inconsistent");
    }
    this.primaryPresent = senders.some((sender) => sender.role === "primary");
    return { senders };
  }
}

export function createDesktopTelegramController(
  input: CreateDesktopTelegramControllerInput,
  dependencies: DesktopTelegramControllerDependencies = {},
): DesktopTelegramController {
  return new DefaultDesktopTelegramController(input, {
    inspectTelegramCredential:
      dependencies.inspectTelegramCredential ?? inspectCoreTelegramCredential,
    deleteTelegramWebhook: dependencies.deleteTelegramWebhook ?? deleteCoreTelegramWebhook,
    claimPrimaryOperator: dependencies.claimPrimaryOperator ?? claimPrimaryOperator,
    listDesktopAllowedSenders: dependencies.listDesktopAllowedSenders ?? listDesktopAllowedSenders,
    addSecondarySender: dependencies.addSecondarySender ?? addSecondarySender,
    removeSecondarySender: dependencies.removeSecondarySender ?? removeSecondarySender,
    createPairing: dependencies.createPairing ?? createDesktopTelegramPairing,
    ...(dependencies.pairingRandomBytes === undefined
      ? {}
      : { pairingRandomBytes: dependencies.pairingRandomBytes }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    ...(dependencies.schedule === undefined ? {} : { schedule: dependencies.schedule }),
    ...(dependencies.cancelSchedule === undefined
      ? {}
      : { cancelSchedule: dependencies.cancelSchedule }),
  });
}
