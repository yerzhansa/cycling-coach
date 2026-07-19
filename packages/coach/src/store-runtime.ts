import { performance } from "node:perf_hooks";
import type { Config, AthleteDataReader, ReferenceRuntime } from "@enduragent/core";
import { createStoreAthleteDataReader } from "@enduragent/core";
import {
  createPhysicalRequestLedger,
  type PhysicalRequestCounts,
  type PhysicalRequestLedger,
  type SyncBudget,
} from "@enduragent/kernel/store";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { join } from "node:path";
import { runReferenceCapture } from "./capture.js";
import { createLocalBundleProducer } from "./local-bundle-producer.js";
import type { CoachStoreWriterContext } from "./runtime.js";
import {
  createWallClockScheduler,
  type WallClockScheduler,
  type WallClockSchedulerDependencies,
} from "./daemon/scheduler.js";

export const STORE_REFRESH_INTERVAL_MS = 21_600_000;
export const STORE_REQUEST_LIMIT = 64 as const;
export const LEGACY_REQUEST_LIMIT = 15 as const;
export const TOTAL_REQUEST_LIMIT = 79 as const;
export const STORE_MAX_ARTIFACTS = 1_000;
export const STORE_REQUEST_TIMEOUT_MS = 30_000;
export const STORE_WINDOW_DEADLINE_MS = 600_000;

export interface StoreWindowResult {
  readonly published: boolean;
  readonly counts: PhysicalRequestCounts;
  readonly legacySucceeded: boolean;
}

export interface StoreRuntimeDependencies {
  readonly capture?: typeof runReferenceCapture;
  readonly produce?: (manifest: ReferenceCaptureManifest) => Promise<ProducedLocalBundle>;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly schedulerDependencies?: Partial<WallClockSchedulerDependencies>;
}

export interface StoreRuntimeOptions {
  readonly env: Record<string, string | undefined>;
  readonly config: Config;
  readonly readConfig?: () => Config;
  readonly home: AthleteHome;
  readonly reference: ReferenceRuntime;
  readonly writerContext?: CoachStoreWriterContext;
  readonly dependencies?: StoreRuntimeDependencies;
}

function sameHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

export class StoreRuntime {
  readonly athleteData: AthleteDataReader;
  private readonly dependencies: Required<
    Pick<StoreRuntimeDependencies, "capture" | "produce" | "now" | "monotonicNow">
  >;
  private readonly scheduler: WallClockScheduler;
  private snapshotValue: ProducedLocalBundle | undefined;
  private activeLedger: PhysicalRequestLedger | undefined;
  private activeController: AbortController | undefined;
  private activeBeforeWindowController: AbortController | undefined;
  private activeWindow: Promise<StoreWindowResult> | undefined;
  private closed = false;

  constructor(private readonly options: StoreRuntimeOptions) {
    if (
      options.writerContext !== undefined &&
      !sameHome(options.home, options.writerContext.home)
    ) {
      throw new TypeError("Writer home does not match the store runtime home.");
    }
    const dependencies = options.dependencies ?? {};
    const now = dependencies.now ?? (() => new Date());
    const schedulerDependencies = dependencies.schedulerDependencies ?? {};
    this.dependencies = {
      capture: dependencies.capture ?? runReferenceCapture,
      produce:
        dependencies.produce ??
        ((manifest) =>
          createLocalBundleProducer({
            storePath: join(options.home.storeDir, "store.db"),
            archiveRoot: options.home.archiveDir,
          }).produce(manifest)),
      now,
      monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
    };
    this.scheduler = createWallClockScheduler({
      cadenceMs: STORE_REFRESH_INTERVAL_MS,
      run: async () => {
        await this.runWindow();
      },
      dependencies: {
        nowEpochMs: schedulerDependencies.nowEpochMs ?? (() => now().getTime()),
        setTimeout: schedulerDependencies.setTimeout ?? globalThis.setTimeout,
        clearTimeout: schedulerDependencies.clearTimeout ?? globalThis.clearTimeout,
      },
    });
    this.athleteData = createStoreAthleteDataReader({
      snapshot: () => this.snapshotValue,
      clockNow: () => this.dependencies.now().getTime(),
    });
  }

  attemptLedgerForRun(): PhysicalRequestLedger {
    if (this.activeLedger === undefined) throw new Error("No paired refresh window is active.");
    return this.activeLedger;
  }

  currentSnapshot(): ProducedLocalBundle | undefined {
    return this.snapshotValue;
  }

  startScheduler(): void {
    if (this.closed) return;
    this.scheduler.start();
  }

  runWindow(): Promise<StoreWindowResult> {
    if (this.closed) return Promise.reject(new Error("Store runtime is closed."));
    if (this.activeWindow !== undefined) return this.activeWindow;
    const task = this.runWindowInternal();
    this.activeWindow = task;
    void task
      .finally(() => {
        if (this.activeWindow === task) this.activeWindow = undefined;
      })
      .catch(() => {});
    return task;
  }

  runWindowAfter(work: (signal: AbortSignal) => Promise<void>): Promise<StoreWindowResult> {
    if (typeof work !== "function")
      return Promise.reject(new TypeError("Window work must be a function."));
    if (this.closed) return Promise.reject(new Error("Store runtime is closed."));
    if (this.activeWindow !== undefined) {
      const active = this.activeWindow;
      const task = active.then(
        () => this.runBeforeWindow(work),
        () => this.runBeforeWindow(work),
      );
      this.installActiveWindow(task);
      return task;
    }
    const task = this.runBeforeWindow(work);
    this.installActiveWindow(task);
    return task;
  }

  private runBeforeWindow(
    work: (signal: AbortSignal) => Promise<void>,
  ): Promise<StoreWindowResult> {
    if (this.closed) return Promise.reject(new Error("Store runtime is closed."));
    const controller = new AbortController();
    const task = Promise.resolve()
      .then(() => work(controller.signal))
      .then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return this.runWindowInternal();
      });
    this.activeBeforeWindowController = controller;
    void task
      .finally(() => {
        if (this.activeBeforeWindowController === controller) {
          this.activeBeforeWindowController = undefined;
        }
      })
      .catch(() => {});
    return task;
  }

  private installActiveWindow(task: Promise<StoreWindowResult>): void {
    this.activeWindow = task;
    void task
      .finally(() => {
        if (this.activeWindow === task) this.activeWindow = undefined;
      })
      .catch(() => {});
  }

  private async runWindowInternal(): Promise<StoreWindowResult> {
    const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
    const controller = new AbortController();
    this.activeLedger = ledger;
    this.activeController = controller;
    const now = this.dependencies.now();
    const monotonicStart = this.dependencies.monotonicNow();
    const budget: SyncBudget = {
      signal: controller.signal,
      clock: { monotonicNow: this.dependencies.monotonicNow },
      deadlineMonotonicMs: monotonicStart + STORE_WINDOW_DEADLINE_MS,
      perRequestTimeoutMs: STORE_REQUEST_TIMEOUT_MS,
      maxRequests: STORE_REQUEST_LIMIT,
      maxArtifacts: STORE_MAX_ARTIFACTS,
    };
    try {
      const config = this.options.readConfig?.() ?? this.options.config;
      const capturePromise =
        config.intervals.apiKey.length === 0
          ? Promise.resolve(undefined)
          : this.dependencies.capture({
              env: this.options.env,
              ...(this.options.writerContext === undefined
                ? {}
                : { writerContext: this.options.writerContext }),
              apiKey: config.intervals.apiKey,
              athleteId: config.intervals.athleteId,
              reviewedOn: now.toISOString().slice(0, 10),
              reason: this.snapshotValue === undefined ? "initial" : "provider-refresh",
              ...(this.snapshotValue === undefined
                ? {}
                : { replacesCaptureId: this.snapshotValue.captureId }),
              budget,
              attemptLedger: ledger,
            });
      const legacyPromise = this.options.reference.runScheduledOnce();
      const [captureResult, legacyResult] = await Promise.allSettled([
        capturePromise,
        legacyPromise,
      ]);
      let published = false;
      if (captureResult.status === "fulfilled" && captureResult.value !== undefined) {
        const produced = await this.dependencies.produce(captureResult.value);
        this.snapshotValue = produced;
        published = true;
      }
      const counts = ledger.snapshot();
      if (captureResult.status === "rejected") throw captureResult.reason;
      return Object.freeze({
        published,
        counts,
        legacySucceeded:
          legacyResult.status === "fulfilled" && legacyResult.value.kind !== "failed",
      });
    } finally {
      if (this.activeLedger === ledger) this.activeLedger = undefined;
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.activeBeforeWindowController?.abort(new Error("Store runtime closed."));
    this.activeController?.abort(new Error("Store runtime closed."));
    await this.scheduler.close();
    try {
      await this.activeWindow;
    } catch {}
  }
}

export function createStoreRuntime(options: StoreRuntimeOptions): StoreRuntime {
  return new StoreRuntime(options);
}
