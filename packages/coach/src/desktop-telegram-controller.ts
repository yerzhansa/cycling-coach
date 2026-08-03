export interface DesktopTelegramRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  drainPending(): Promise<void>;
}

export interface DesktopTelegramRuntimeFactoryInput {
  readonly token: string;
  readonly onStarted: () => void;
}

export type DesktopTelegramControllerStatus =
  | Readonly<{ desiredState: "disabled"; state: "disabled" }>
  | Readonly<{ desiredState: "enabled"; state: "starting" | "online" }>
  | Readonly<{
      desiredState: "enabled";
      errorCode: "telegram-invalid-token";
      state: "invalid-token";
    }>
  | Readonly<{
      desiredState: "enabled";
      errorCode: "telegram-polling-conflict";
      state: "conflict";
    }>
  | Readonly<{
      desiredState: "enabled";
      errorCode: "telegram-start-failed";
      state: "failed";
    }>;

export interface DesktopTelegramController {
  getStatus(): DesktopTelegramControllerStatus;
  enable(token: string): Promise<void>;
  disable(): Promise<void>;
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
  pollingState: "running" | "stopping" | "paused";
  resumeRequested: boolean;
  stopTask?: Promise<void>;
  drainTask?: Promise<void>;
}

const DISABLED_STATUS = Object.freeze({
  desiredState: "disabled",
  state: "disabled",
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
  private desiredEnabled = false;
  private generation = 0;
  private active: ActiveRuntime | undefined;

  constructor(
    private readonly createRuntime: CreateDesktopTelegramControllerInput["createRuntime"],
  ) {}

  getStatus(): DesktopTelegramControllerStatus {
    return this.status;
  }

  async enable(token: string): Promise<void> {
    if (this.desiredEnabled) return;

    this.desiredEnabled = true;
    const generation = ++this.generation;
    this.status = STARTING_STATUS;

    const previous = this.active;
    if (previous) {
      await this.stopRuntime(previous);
      await this.drainRuntime(previous);
      if (this.active === previous) this.active = undefined;
    }

    if (!this.isCurrent(generation)) return;

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
      resumeRequested: false,
    };
    this.active = active;
    this.startRuntime(active);
  }

  async disable(): Promise<void> {
    await this.close();
  }

  async stopPolling(): Promise<void> {
    const active = this.active;
    if (!active || active.pollingState === "paused") return;
    if (active.pollingState === "stopping") {
      await active.stopTask;
      return;
    }
    active.pollingState = "stopping";
    active.attempt += 1;
    if (this.isActive(active)) this.status = STARTING_STATUS;
    await this.stopRuntime(active);
    if (this.isActive(active) && active.pollingState === "stopping") {
      active.pollingState = "paused";
      if (active.resumeRequested) this.resumeRuntime(active);
    }
  }

  async resumePolling(): Promise<void> {
    const active = this.active;
    if (
      !this.desiredEnabled ||
      active === undefined ||
      active.pollingState === "running"
    ) {
      return;
    }
    if (active.pollingState === "stopping") {
      active.resumeRequested = true;
      return;
    }
    this.resumeRuntime(active);
  }

  private resumeRuntime(active: ActiveRuntime): void {
    active.resumeRequested = false;
    active.pollingState = "running";
    active.stopTask = undefined;
    active.drainTask = undefined;
    this.status = STARTING_STATUS;
    this.startRuntime(active);
  }

  async drainPending(): Promise<void> {
    const active = this.active;
    if (active) await this.drainRuntime(active);
  }

  async close(): Promise<void> {
    const active = this.beginStop();
    if (!active) return;

    await this.stopRuntime(active);
    await this.drainRuntime(active);
    if (this.active === active) this.active = undefined;
  }

  private beginStop(): ActiveRuntime | undefined {
    this.desiredEnabled = false;
    this.generation += 1;
    this.status = DISABLED_STATUS;
    if (this.active !== undefined) {
      this.active.attempt += 1;
      this.active.pollingState = "stopping";
      this.active.resumeRequested = false;
    }
    return this.active;
  }

  private isCurrent(generation: number): boolean {
    return this.desiredEnabled && this.generation === generation;
  }

  private reportOnline(generation: number): void {
    if (
      this.isCurrent(generation) &&
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
    if (this.isAttemptActive(active, attempt)) this.status = FAILED_STATUS;
  }

  private handleStartRejection(active: ActiveRuntime, attempt: number, error: unknown): void {
    if (!this.isAttemptActive(active, attempt)) return;

    const errorCode = telegramErrorCode(error);
    if (errorCode === 401) {
      this.status = INVALID_TOKEN_STATUS;
    } else if (errorCode === 409) {
      this.status = CONFLICT_STATUS;
    } else {
      this.status = FAILED_STATUS;
    }
  }

  private isActive(active: ActiveRuntime): boolean {
    return this.active === active && this.isCurrent(active.generation);
  }

  private isAttemptActive(active: ActiveRuntime, attempt: number): boolean {
    return this.isActive(active) && active.attempt === attempt;
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
