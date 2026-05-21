import { join } from "node:path";
import {
  MUTEX_ACQUIRE_TIMEOUT_MS,
  MUTEX_HOT_WARN_MS,
  SCHEDULED_SYNC_INTERVAL_MS,
  SYNC_OPERATION_TIMEOUT_MS,
} from "../freshness.js";
import { atomicWriteJson } from "../../io/atomic-write-json.js";
import { LATEST_SCHEMA_VERSION } from "../schemas/latest.js";
import { HISTORY_SCHEMA_VERSION } from "../schemas/history.js";
import { INTERVALS_SCHEMA_VERSION } from "../schemas/intervals.js";
import { ROUTES_SCHEMA_VERSION } from "../schemas/routes.js";
import { FTP_HISTORY_SCHEMA_VERSION } from "../schemas/ftp-history.js";
import { SCHEDULER_SCHEMA_VERSION } from "../schemas/scheduler.js";
import type { ErrorPhase, ErrorCaller } from "../schemas/error-state.js";
import { gateLatestJson } from "../validation/sync-gate.js";
import { writeErrorState } from "./error-state-writer.js";
import type { AsyncMutex } from "../../concurrency/mutex.js";
import type { Cooldown } from "../../concurrency/cooldown.js";
import type { Clock } from "../../concurrency/clock.js";

/**
 * Re-exported from `error-state.ts` so the runtime opt and the on-disk
 * persisted schema share a single source of truth (`SYNC_CALLERS` tuple).
 * Adding a new caller updates both in lockstep.
 */
export type SyncCaller = ErrorCaller;

export interface RunSyncOpts {
  readonly forceFresh?: boolean;
  readonly extendRetentionUntil?: string;
  readonly caller?: SyncCaller;
  /** Required when `caller === "/sync"` for per-chat cooldown gating. */
  readonly chatId?: string;
}

export type CacheFile = "latest" | "history" | "intervals" | "routes" | "ftp_history";

export interface SyncFailure {
  readonly file: string;
  readonly reason: string;
}

/**
 * Discriminated-union outcome shape per ADR-0011's "future horizontal layers
 * copy this orchestrator pattern" — Decision Layer's `runReadinessCheck` and
 * Heartbeat's `runHeartbeat` will mirror this shape. Three exhaustive cases:
 *
 *   - `ran`     — body completed successfully; cache files are committed.
 *   - `skipped` — orchestrator declined to run (cooldown or contended mutex);
 *                 caller may retry after `retryAfterMs` (cooldown only).
 *   - `failed`  — body started but did not produce a valid commit. Cache
 *                 state may be partial (timeout) or untouched (gate_rejected).
 *                 `error_state.json` is written; curator (Wave 5) reads it.
 */
export type SyncResult =
  | {
      readonly kind: "ran";
      readonly lastSyncAt: string;
      readonly refreshed: readonly CacheFile[];
    }
  | {
      readonly kind: "skipped";
      readonly reason: "cooldown" | "mutex_held";
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: "failed";
      readonly reason: "outer_timeout" | "gate_rejected";
      readonly failures: readonly SyncFailure[];
    };

export interface FetchedReference {
  readonly latest: {
    readonly athlete_profile: unknown;
    readonly current_status: unknown;
    readonly derived_metrics: unknown;
    readonly recent_activities: readonly unknown[];
    readonly planned_workouts: readonly unknown[];
    readonly wellness_data: unknown;
  };
  readonly history: {
    readonly daily: readonly unknown[];
    readonly weekly: readonly unknown[];
    readonly monthly: readonly unknown[];
  };
  readonly intervals: {
    readonly by_activity: Readonly<Record<string, readonly unknown[]>>;
  };
  readonly routes: { readonly routes: readonly unknown[] };
  readonly ftp_history: { readonly entries: readonly unknown[] };
}

export interface RunSyncDeps {
  readonly dataDir: string;
  readonly mutex: AsyncMutex;
  readonly cooldown: Cooldown;
  readonly cooldownWindowMs: number;
  readonly fetchReferenceData: (signal: AbortSignal) => Promise<FetchedReference>;
  /** @deprecated prefer `clock.now`; retained for tests that pin time only. */
  readonly now?: () => Date;
  /**
   * Injectable clock primitives. Unifies the `now`/`setTimeout`/`clearTimeout`
   * boundary so tests can drive the outer-timeout deterministically without
   * relying on vitest's fake timers (which don't intercept `AbortSignal.timeout`
   * cleanly under the parallel pool).
   */
  readonly clock?: Partial<Clock>;
  /** Override timing constants for tests; defaults from `freshness.ts`. */
  readonly timing?: {
    readonly acquireTimeoutMs?: number;
    readonly hotWarnMs?: number;
    readonly outerTimeoutMs?: number;
    readonly scheduledIntervalMs?: number;
  };
  /** Override Layer-1 gate for tests; defaults to the Wave-1 stub `gateLatestJson`. */
  readonly gate?: typeof gateLatestJson;
  /** Override atomic write for tests; defaults to `atomicWriteJson`. */
  readonly atomicWrite?: (path: string, value: unknown) => Promise<void>;
}

interface CacheWriteSpec {
  readonly file: CacheFile;
  readonly version: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly extras?: Readonly<Record<string, unknown>>;
}

/** Shared between runtime + tests so the warn-after-timeout string stays in sync. */
export const BODY_AFTER_TIMEOUT_LOG_PREFIX = "Reference: body threw after outer timeout";

export function createRunSync(
  deps: RunSyncDeps,
): (opts?: RunSyncOpts) => Promise<SyncResult> {
  const now = deps.clock?.now ?? deps.now ?? (() => new Date());
  const setTimeoutFn: (fn: () => void, ms: number) => unknown =
    deps.clock?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn: (handle: unknown) => void =
    deps.clock?.clearTimeout ??
    ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const acquireTimeoutMs = deps.timing?.acquireTimeoutMs ?? MUTEX_ACQUIRE_TIMEOUT_MS;
  const hotWarnMs = deps.timing?.hotWarnMs ?? MUTEX_HOT_WARN_MS;
  const outerTimeoutMs = deps.timing?.outerTimeoutMs ?? SYNC_OPERATION_TIMEOUT_MS;
  const scheduledIntervalMs = deps.timing?.scheduledIntervalMs ?? SCHEDULED_SYNC_INTERVAL_MS;
  const gate = deps.gate ?? gateLatestJson;
  const writeJson = deps.atomicWrite ?? atomicWriteJson;

  return async (opts = {}) => {
    if (opts.caller === "/sync" && opts.chatId !== undefined) {
      const c = deps.cooldown.check(opts.chatId, deps.cooldownWindowMs);
      if (!c.ok) {
        return {
          kind: "skipped",
          reason: "cooldown",
          retryAfterMs: c.retryAfterMs,
        };
      }
    }

    const mutexResult = await deps.mutex.runExclusive(
      async (): Promise<SyncResult> => {
        const controller = new AbortController();
        let phase: ErrorPhase = "fetching";

        // Returned at any phase boundary where `controller.signal.aborted` is
        // true after an `await` resolves. Prevents body from doing the next
        // write phase once the outer timeout has fired (A1 from QA review).
        const abortedResult = (): SyncResult => ({
          kind: "failed",
          reason: "outer_timeout",
          failures: [],
        });

        const body = async (): Promise<SyncResult> => {
          const fetched = await deps.fetchReferenceData(controller.signal);
          if (controller.signal.aborted) return abortedResult();

          phase = "gating";
          const gateResult = gate(fetched, null);
          if (!gateResult.ok) {
            await writeErrorState(deps.dataDir, {
              step: "gate_rejected",
              detail: gateResult.failures.map((f) => `${f.step}: ${f.detail}`).join("; "),
            });
            return {
              kind: "failed",
              reason: "gate_rejected",
              failures: gateResult.failures.map((f) => ({
                file: "latest",
                reason: `${f.step}: ${f.detail}`,
              })),
            };
          }
          if (controller.signal.aborted) return abortedResult();

          const lastUpdated = now().toISOString();
          phase = "writing_cache";

          // Cache files are independent — parallelize. ADR-0011 only requires
          // `.scheduler.json` (commit marker) to land LAST; that write follows
          // the Promise.all below. The asymmetric `freshness: "fresh"` on
          // `latest` is encoded as data via the `extras` field, so adding a
          // new cache file in a future wave is one row, not one branch.
          const cacheWrites: readonly CacheWriteSpec[] = [
            {
              file: "latest",
              version: LATEST_SCHEMA_VERSION,
              payload: fetched.latest,
              extras: { freshness: "fresh" },
            },
            { file: "history", version: HISTORY_SCHEMA_VERSION, payload: fetched.history },
            { file: "intervals", version: INTERVALS_SCHEMA_VERSION, payload: fetched.intervals },
            { file: "routes", version: ROUTES_SCHEMA_VERSION, payload: fetched.routes },
            {
              file: "ftp_history",
              version: FTP_HISTORY_SCHEMA_VERSION,
              payload: fetched.ftp_history,
            },
          ];
          await Promise.all(
            cacheWrites.map(({ file, version, payload, extras }) =>
              writeJson(join(deps.dataDir, `${file}.json`), {
                metadata: { schema_version: version, last_updated: lastUpdated, ...extras },
                ...payload,
              }),
            ),
          );
          // A1 fix: if the outer timeout fired during the cache writes,
          // bail before writing the commit marker. Without this guard the
          // scheduler.json could land after error_state.json was written,
          // producing contradictory on-disk markers (curator confusion).
          if (controller.signal.aborted) return abortedResult();

          // Commit-marker LAST per ADR-0011.
          phase = "writing_scheduler";
          await writeJson(join(deps.dataDir, ".scheduler.json"), {
            schema_version: SCHEDULER_SCHEMA_VERSION,
            last_sync_at: lastUpdated,
            next_sync_at: new Date(now().getTime() + scheduledIntervalMs).toISOString(),
          });

          return {
            kind: "ran",
            lastSyncAt: lastUpdated,
            refreshed: cacheWrites.map((w) => w.file),
          };
        };

        let bodyResult: SyncResult | undefined;
        let bodyError: unknown;
        // `bodySettled` swallows both branches; subsequent `.then` chains
        // never see a rejection. If a future refactor adds `throw` to the
        // handlers, the post-timeout logger below would also need a catch.
        const bodySettled = body().then(
          (r) => {
            bodyResult = r;
          },
          (e) => {
            bodyError = e;
          },
        );

        let timerHandle: unknown;
        const timerFired = new Promise<true>((resolve) => {
          timerHandle = setTimeoutFn(() => resolve(true), outerTimeoutMs);
        });

        const winner = await Promise.race([
          bodySettled.then(() => "body" as const),
          timerFired.then(() => "timeout" as const),
        ]);

        if (timerHandle !== undefined) clearTimeoutFn(timerHandle);

        if (winner === "timeout") {
          controller.abort();
          // A2 fix: a body that throws AFTER the outer timeout fired
          // would otherwise have its error captured in `bodyError` and
          // never observed (we already returned). Log it so a regression
          // in body-after-timeout handling is visible in stderr.
          bodySettled.then(() => {
            if (bodyError !== undefined) {
              console.warn(
                `${BODY_AFTER_TIMEOUT_LOG_PREFIX} — ${bodyError instanceof Error ? bodyError.message : String(bodyError)}`,
              );
            }
          });
          await writeErrorState(deps.dataDir, {
            step: "outer_timeout",
            phase,
            detail: `runSync exceeded ${outerTimeoutMs}ms during ${phase} phase`,
          });
          return { kind: "failed", reason: "outer_timeout", failures: [] };
        }

        if (bodyError !== undefined) throw bodyError;
        return bodyResult!;
      },
      {
        acquireTimeoutMs,
        hotWarnMs,
        caller: opts.caller ?? "scheduled",
      },
    );

    if (mutexResult.kind === "timeout") {
      return { kind: "skipped", reason: "mutex_held" };
    }

    const result = mutexResult.value;
    if (result.kind === "ran" && opts.caller === "/sync" && opts.chatId !== undefined) {
      deps.cooldown.record(opts.chatId);
    }
    return result;
  };
}
