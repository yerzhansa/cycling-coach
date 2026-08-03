import type { TelegramChannelStatus } from "@enduragent/coach-contract";

export interface DesktopTelegramRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  drainPending(): Promise<void>;
}

export interface DesktopTelegramRuntimeFactoryInput {
  readonly token: string;
  readonly onStarted: () => void;
}

export type DesktopTelegramControllerStatus = TelegramChannelStatus;

export interface DesktopTelegramController {
  getStatus(): DesktopTelegramControllerStatus;
  configure(token: string): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  replace(token: string): Promise<void>;
  reconcile(): Promise<void>;
  stopPolling(): Promise<void>;
  resumePolling(): Promise<void>;
  drainPending(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateDesktopTelegramControllerInput {
  readonly createRuntime: (input: DesktopTelegramRuntimeFactoryInput) => DesktopTelegramRuntime;
}

interface ActiveRuntime {
  readonly generation: number;
  readonly runtime: DesktopTelegramRuntime;
  attempt: number;
  pollingState: "running" | "paused";
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

function telegramErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("error_code" in error)) {
    return undefined;
  }
  const value = error.error_code;
  return typeof value === "number" ? value : undefined;
}

class DefaultDesktopTelegramController implements DesktopTelegramController {
  private status: DesktopTelegramControllerStatus = DISABLED_STATUS;
  private configuredToken: string | undefined;
  private desiredEnabled = false;
  private pollingSuspended = false;
  private generation = 0;
  private active: ActiveRuntime | undefined;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly createRuntime: CreateDesktopTelegramControllerInput["createRuntime"],
  ) {}

  getStatus(): DesktopTelegramControllerStatus {
    return this.status;
  }

  configure(token: string): Promise<void> {
    return this.serialize(async () => {
      if (this.configuredToken !== undefined) return;
      this.configuredToken = token;
      await this.reconcileUnlocked();
    });
  }

  enable(): Promise<void> {
    return this.serialize(async () => {
      this.desiredEnabled = true;
      await this.reconcileUnlocked();
    });
  }

  disable(): Promise<void> {
    return this.serialize(() => this.disableUnlocked());
  }

  replace(token: string): Promise<void> {
    return this.serialize(async () => {
      const previous = this.invalidateActive();
      this.status = this.desiredEnabled ? STARTING_STATUS : DISABLED_STATUS;
      if (previous !== undefined) {
        await this.stopRuntime(previous);
        await this.drainRuntime(previous);
        if (this.active === previous) this.active = undefined;
      }
      this.configuredToken = token;
      if (this.desiredEnabled) await this.startConfiguredRuntime();
    });
  }

  reconcile(): Promise<void> {
    return this.serialize(() => this.reconcileUnlocked());
  }

  stopPolling(): Promise<void> {
    this.pollingSuspended = true;
    return this.serialize(async () => {
      const active = this.active;
      if (active === undefined) {
        if (this.desiredEnabled && this.configuredToken !== undefined) {
          this.status = STARTING_STATUS;
        }
        return;
      }
      if (active.pollingState === "paused") return;
      this.status = STARTING_STATUS;
      await this.pauseRuntime(active);
    });
  }

  resumePolling(): Promise<void> {
    return this.serialize(async () => {
      this.pollingSuspended = false;
      await this.reconcileUnlocked();
    });
  }

  drainPending(): Promise<void> {
    return this.serialize(async () => {
      const active = this.active;
      if (active !== undefined) await this.drainRuntime(active);
    });
  }

  close(): Promise<void> {
    return this.disable();
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const task = this.mutationTail.then(operation, operation);
    this.mutationTail = task.catch(() => undefined);
    return task;
  }

  private async disableUnlocked(): Promise<void> {
    this.desiredEnabled = false;
    this.status = DISABLED_STATUS;
    const active = this.invalidateActive();
    if (active === undefined) return;
    await this.stopRuntime(active);
    await this.drainRuntime(active);
    if (this.active === active) this.active = undefined;
  }

  private async reconcileUnlocked(): Promise<void> {
    if (!this.desiredEnabled) {
      this.status = DISABLED_STATUS;
      return;
    }
    if (this.configuredToken === undefined) {
      this.status = WAITING_FOR_CREDENTIAL_STATUS;
      return;
    }
    const active = this.active;
    if (this.pollingSuspended) {
      if (active !== undefined && active.pollingState === "running") {
        this.status = STARTING_STATUS;
        await this.pauseRuntime(active);
      } else if (active === undefined) {
        this.status = STARTING_STATUS;
      }
      return;
    }
    if (active === undefined) {
      await this.startConfiguredRuntime();
      return;
    }
    if (active.pollingState === "paused" && !active.restartBlocked) {
      this.resumeRuntime(active);
    }
  }

  private async startConfiguredRuntime(): Promise<void> {
    const token = this.configuredToken;
    if (!this.desiredEnabled || token === undefined) return;
    if (this.pollingSuspended) {
      this.status = STARTING_STATUS;
      return;
    }
    const generation = ++this.generation;
    this.status = STARTING_STATUS;
    let runtime: DesktopTelegramRuntime;
    try {
      runtime = this.createRuntime({
        token,
        onStarted: () => this.reportOnline(generation),
      });
    } catch {
      if (this.isCurrent(generation)) this.status = FAILED_STATUS;
      return;
    }
    const active: ActiveRuntime = {
      generation,
      runtime,
      attempt: 0,
      pollingState: "running",
      restartBlocked: false,
    };
    this.active = active;
    this.startRuntime(active);
  }

  private invalidateActive(): ActiveRuntime | undefined {
    this.generation += 1;
    const active = this.active;
    if (active !== undefined) {
      active.attempt += 1;
      active.pollingState = "paused";
    }
    return active;
  }

  private async pauseRuntime(active: ActiveRuntime): Promise<void> {
    active.attempt += 1;
    active.pollingState = "paused";
    await this.stopRuntime(active);
  }

  private resumeRuntime(active: ActiveRuntime): void {
    active.stopTask = undefined;
    active.drainTask = undefined;
    active.pollingState = "running";
    active.restartBlocked = false;
    this.status = STARTING_STATUS;
    this.startRuntime(active);
  }

  private isCurrent(generation: number): boolean {
    return this.desiredEnabled && this.generation === generation;
  }

  private reportOnline(generation: number): void {
    const active = this.active;
    if (
      this.isCurrent(generation) &&
      active?.generation === generation &&
      active.pollingState === "running" &&
      !active.restartBlocked &&
      !this.pollingSuspended &&
      (this.status.state === "starting" || this.status.state === "online")
    ) {
      this.status = ONLINE_STATUS;
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
    active.restartBlocked = true;
    this.status = FAILED_STATUS;
  }

  private handleStartRejection(active: ActiveRuntime, attempt: number, error: unknown): void {
    if (!this.isAttemptActive(active, attempt)) return;
    active.pollingState = "paused";
    active.restartBlocked = true;
    const errorCode = telegramErrorCode(error);
    if (errorCode === 401) {
      this.status = INVALID_TOKEN_STATUS;
    } else if (errorCode === 409) {
      this.status = CONFLICT_STATUS;
    } else {
      this.status = FAILED_STATUS;
    }
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
}

export function createDesktopTelegramController(
  input: CreateDesktopTelegramControllerInput,
): DesktopTelegramController {
  return new DefaultDesktopTelegramController(input.createRuntime);
}
