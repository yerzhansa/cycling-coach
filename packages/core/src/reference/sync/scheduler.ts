// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import { join } from "node:path";
import { safeReadJson } from "../../io/safe-read-json.js";
import { SchedulerStateSchema } from "../schemas/scheduler.js";
import type { RunSyncOpts, SyncResult } from "./run-sync.js";

/**
 * In-process scheduler for the periodic Reference sync. Two-phase per
 * ADR-0011: `new Scheduler(...)` reads persisted state but registers no
 * timer; `start()` is called by the binary's init only AFTER the first
 * runSync resolves so the cold-start tick-vs-first-sync race is structurally
 * impossible.
 */
export interface SchedulerDeps {
  readonly dataDir: string;
  readonly runSync: (opts: RunSyncOpts) => Promise<SyncResult>;
  readonly intervalMs: number;
  readonly now?: () => Date;
}

export class Scheduler {
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private nextDelay = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  /**
   * Register the periodic timer. Reads `.scheduler.json` exactly once on
   * first start to determine the FIRST tick's delay (per ADR-0011: the
   * commit-marker the previous runSync wrote tells us when to fire next).
   * After the first tick, subsequent ticks fire every `intervalMs`.
   * Idempotent.
   */
  start(): void {
    if (this.stopped) return;
    if (this.timerHandle !== null) return;

    const state = safeReadJson(
      join(this.deps.dataDir, ".scheduler.json"),
      SchedulerStateSchema,
    );
    const nowFn = this.deps.now ?? (() => new Date());
    if (state !== null && state.next_sync_at !== null) {
      this.nextDelay = Math.max(
        0,
        new Date(state.next_sync_at).getTime() - nowFn().getTime(),
      );
    } else {
      this.nextDelay = 0;
    }

    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timerHandle !== null) {
      clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }

  private scheduleNext(): void {
    this.timerHandle = setTimeout(async () => {
      this.timerHandle = null;
      try {
        await this.deps.runSync({ caller: "scheduled" });
      } catch (err) {
        // runSync handles its own failures internally (writes error_state.json).
        // Anything escaping here is a bug above that layer — log it so
        // production regressions don't disappear into a silent loop.
        console.warn(
          `Reference: scheduler tick threw (${err instanceof Error ? err.message : String(err)}). Continuing.`,
        );
      }
      if (!this.stopped) {
        this.nextDelay = this.deps.intervalMs;
        this.scheduleNext();
      }
    }, this.nextDelay);
  }
}
