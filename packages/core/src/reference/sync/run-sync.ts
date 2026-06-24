import { join } from "node:path";
import type { ZodTypeAny } from "zod";
import {
  MUTEX_ACQUIRE_TIMEOUT_MS,
  MUTEX_HOT_WARN_MS,
  SCHEDULED_SYNC_INTERVAL_MS,
  SYNC_OPERATION_TIMEOUT_MS,
} from "../freshness.js";
import { atomicWriteJson } from "../../io/atomic-write-json.js";
import { safeReadJson } from "../../io/safe-read-json.js";
import { LATEST_SCHEMA_VERSION, LatestJsonSchema, type DerivedMetricsMeta } from "../schemas/latest.js";
import { HISTORY_SCHEMA_VERSION, HistoryJsonSchema } from "../schemas/history.js";
import { INTERVALS_SCHEMA_VERSION, IntervalsJsonSchema } from "../schemas/intervals.js";
import { ROUTES_SCHEMA_VERSION, RoutesJsonSchema } from "../schemas/routes.js";
import { FTP_HISTORY_SCHEMA_VERSION, FtpHistoryJsonSchema } from "../schemas/ftp-history.js";
import { SCHEDULER_SCHEMA_VERSION } from "../schemas/scheduler.js";
import { ErrorStateSchema } from "../schemas/error-state.js";
import type { ErrorPhase, ErrorCaller, ErrorState } from "../schemas/error-state.js";
import { gateLatestJson } from "../validation/sync-gate.js";
import { writeErrorState, clearErrorState } from "./error-state-writer.js";
import {
  createSyncHistoryWriter,
  SYNC_HISTORY_SCHEMA_VERSION,
  type SyncOutcomeLine,
} from "./sync-history.js";
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
 *                 `error_state.json` is written; the curator reads it.
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
      readonly reason: "outer_timeout" | "gate_rejected" | "fetch_failed";
      readonly failures: readonly SyncFailure[];
    };

export interface FetchedReference {
  readonly latest: {
    readonly athlete_profile: unknown;
    readonly current_status: unknown;
    readonly derived_metrics: unknown;
    /** Emit-time provenance tag — a sibling of `derived_metrics`, never inside
     *  it. Optional: an empty-coverage bundle attaches no tag. `prescriptionBasis`
     *  is the adapter's declared prescription anchor; `analysisBasis` is the
     *  substrate the distribution numbers were actually computed off. */
    readonly derived_metrics_meta?: DerivedMetricsMeta;
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
  /** Source endpoints that errored during the fetch (athlete-profile, wellness).
   *  Present + non-empty means a fetch failed and was filled with empty data;
   *  step0 hard-fails on it so the swallowed failure can no longer commit empties
   *  behind a fresh stamp. Omitted when every endpoint was reachable, so a
   *  fully-successful fetch is shape-identical to a genuinely-empty account. */
  readonly fetch_errors?: readonly { readonly endpoint: string; readonly detail: string }[];
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
  /** Override Layer-1 gate for tests; defaults to `gateLatestJson`. */
  readonly gate?: typeof gateLatestJson;
  /** Override atomic write for tests; defaults to `atomicWriteJson`. */
  readonly atomicWrite?: (
    path: string,
    value: unknown,
    opts?: { signal?: AbortSignal },
  ) => Promise<void>;
  /** Override error_state.json removal for tests; defaults to `clearErrorState`. */
  readonly clearError?: (dataDir: string, opts?: { signal?: AbortSignal }) => Promise<void>;
  /**
   * Override the per-tick outcome writer for tests; defaults to
   * `createSyncHistoryWriter(deps.dataDir)`. Best-effort and never throws, so it
   * can never alter or break the `SyncResult` it records.
   */
  readonly syncHistory?: (line: SyncOutcomeLine) => void;
}

interface CacheWriteSpec {
  readonly file: CacheFile;
  readonly version: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly extras?: Readonly<Record<string, unknown>>;
}

/** Shared between runtime + tests so the warn-after-timeout string stays in sync. */
export const BODY_AFTER_TIMEOUT_LOG_PREFIX = "Reference: body threw after outer timeout";

/** Per-cache-file Zod schema, so the prior-read routes through the same
 *  `safeReadJson` boundary every other Reference read uses (CONTEXT.md: Reference
 *  NEVER calls `JSON.parse(readFileSync(...))` directly). A schema mismatch or an
 *  unreadable file yields `null` — which `readPriorCache` already treats as "no
 *  comparable prior, must write". */
const CACHE_SCHEMAS: Readonly<Record<CacheFile, ZodTypeAny>> = {
  latest: LatestJsonSchema,
  history: HistoryJsonSchema,
  intervals: IntervalsJsonSchema,
  routes: RoutesJsonSchema,
  ftp_history: FtpHistoryJsonSchema,
};

/** Read a prior on-disk cache file as a parsed object, or `null` when it is
 *  absent / unreadable / schema-invalid — any of which means "no comparable
 *  prior, must write". */
function readPriorCache(path: string, file: CacheFile): Record<string, unknown> | null {
  return safeReadJson<Record<string, unknown>>(path, CACHE_SCHEMAS[file]);
}

/** Carry forward an active `block_coaching` mitigation onto a subsequent
 *  failure-path write. `error_state.json` is single-slot/last-writer-wins, so a
 *  transient timeout or fetch failure following a HARD gate rejection would
 *  otherwise overwrite the corruption-class block with a mitigation-less record
 *  and silently re-open coaching while the cache is still unvalidated. A
 *  timeout/fetch failure is an unknown outcome, not proof the cache became
 *  trustworthy — only the clean-sync `clearError` path removes the block. */
function priorBlockCoaching(dataDir: string): { mitigation: "block_coaching" } | undefined {
  const prior = safeReadJson<ErrorState>(join(dataDir, "error_state.json"), ErrorStateSchema);
  return prior?.mitigation === "block_coaching" ? { mitigation: prior.mitigation } : undefined;
}

/** Recursively rebuild an object/array with every object's keys in sorted
 *  order, so two structurally-equal payloads serialize identically regardless
 *  of key insertion order. `priorPayloadEquals` reads the prior payload back
 *  through a Zod re-parse, which rebuilds objects in schema-declaration order
 *  rather than the producer's insertion order; canonicalizing both sides makes
 *  the no-op short-circuit immune to that reordering (and to any future
 *  producer that emits the same data in a different key order). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** True when the prior file's payload (everything except the churning
 *  `metadata` envelope) is structurally equal to the new payload — so a no-op
 *  cycle skips the write and leaves the file byte-identical. The comparison is
 *  key-order-insensitive (see `canonicalize`): the no-op guarantee must not
 *  hinge on the producer emitting keys in the same order the cache schema
 *  declares them. */
function priorPayloadEquals(
  prior: Record<string, unknown>,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const { metadata: _metadata, ...priorPayload } = prior;
  return (
    JSON.stringify(canonicalize(priorPayload)) ===
    JSON.stringify(canonicalize(payload))
  );
}

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
  const clearError = deps.clearError ?? clearErrorState;
  const syncHistory = deps.syncHistory ?? createSyncHistoryWriter(deps.dataDir);

  return async (opts = {}) => {
    const startedAt = now();
    // The outcome line is a best-effort diagnostics trail: a write (or a
    // misbehaving injected writer) must never alter or break the tick it
    // records. The default writer already swallows; this guard also fences a
    // throwing test seam from escaping the tick. A backward wall-clock step
    // between `startedAt` and the emit must never write a negative duration, so
    // the delta is clamped non-negative.
    const emit = (kind: SyncResult["kind"], reason: string | undefined): void => {
      try {
        syncHistory({
          schema_version: SYNC_HISTORY_SCHEMA_VERSION,
          ts: now().toISOString(),
          caller: opts.caller ?? "scheduled",
          kind,
          reason,
          duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
        });
      } catch {
        // Swallowed — see comment above.
      }
    };
    const emitOutcome = (result: SyncResult): SyncResult => {
      emit(result.kind, "reason" in result ? result.reason : undefined);
      return result;
    };

    if (opts.caller === "/sync" && opts.chatId !== undefined) {
      const c = deps.cooldown.check(opts.chatId, deps.cooldownWindowMs);
      if (!c.ok) {
        return emitOutcome({
          kind: "skipped",
          reason: "cooldown",
          retryAfterMs: c.retryAfterMs,
        });
      }
    }

    // Fail fast for the interactive caller: if a sync is already running, the
    // athlete's /sync would otherwise enqueue a waiter and block the full
    // acquire timeout before skipping. Reply immediately instead. The scheduled
    // caller deliberately keeps queue-and-wait semantics (it has no one waiting
    // on a reply), so this branch is /sync-only.
    if (opts.caller === "/sync" && deps.mutex.isHeld()) {
      return emitOutcome({ kind: "skipped", reason: "mutex_held" });
    }

    let mutexResult;
    try {
      mutexResult = await deps.mutex.runExclusive(
        async (): Promise<SyncResult> => {
        const controller = new AbortController();
        let phase: ErrorPhase = "fetching";
        // Set synchronously the instant this cycle classifies the bundle as
        // unusable, before the (async) error_state write. The outer-timeout path
        // races the body's write and cannot re-read error_state.json reliably
        // (the body's rename may not have landed yet), so it ORs this flag in
        // rather than demote a same-cycle HARD rejection to a mitigation-less record.
        let cycleBlockCoaching = false;

        // Returned at any phase boundary where `controller.signal.aborted` is
        // true after an `await` resolves. Prevents body from doing the next
        // write phase once the outer timeout has fired (A1 from QA review).
        const abortedResult = (): SyncResult => ({
          kind: "failed",
          reason: "outer_timeout",
          failures: [],
        });

        const body = async (): Promise<SyncResult> => {
          let fetched: FetchedReference;
          try {
            fetched = await deps.fetchReferenceData(controller.signal);
          } catch (err) {
            // A hard fetch/assembly failure (unreachable list endpoint, a
            // surviving TP-trademarked key, a malformed bundle) must surface to
            // the curator like any other failed sync — write error_state and
            // return `failed`. Letting the rejection escape would leave the
            // scheduled tick logging-only and the curator blind to the failure.
            if (controller.signal.aborted) return abortedResult();
            const detail = err instanceof Error ? err.message : String(err);
            // Route through the injectable abort-aware seam so a late body write skips its rename if the outer timeout already force-released the mutex.
            await writeErrorState(
              deps.dataDir,
              {
                step: "fetch_failed",
                phase,
                detail,
                ...priorBlockCoaching(deps.dataDir),
              },
              { write: writeJson, signal: controller.signal },
            );
            return {
              kind: "failed",
              reason: "fetch_failed",
              failures: [{ file: "latest", reason: detail }],
            };
          }
          if (controller.signal.aborted) return abortedResult();

          phase = "gating";
          // `prior` is null here: no current mechanical check consumes the
          // on-disk LatestJson, so prior-vs-incoming comparison is not yet wired.
          const gateResult = gate(fetched, null, now());
          if (!gateResult.ok) {
            // A HARD gate failure means the freshly-fetched bundle could not be
            // validated — the cache is unvalidated/corrupt. Mark the failure
            // block-coaching so the chat path degrades to general guidance
            // instead of quoting numbers from data we could not trust. The soft
            // path below keeps its non-blocking warn-only mitigation.
            cycleBlockCoaching = true;
            await writeErrorState(
              deps.dataDir,
              {
                step: "gate_rejected",
                detail: gateResult.failures.map((f) => `${f.step}: ${f.detail}`).join("; "),
                mitigation: "block_coaching",
              },
              { write: writeJson, signal: controller.signal },
            );
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
              extras: { freshness: gateResult.freshness ?? "fresh" },
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
          // Content-hash short-circuit: re-stamping `last_updated` every cycle
          // makes each cache file byte-different even when the underlying data
          // is unchanged. The `metadata` envelope (which carries the churning
          // `last_updated`) is excluded from the comparison so a no-op cycle
          // leaves the file — old timestamp and all — byte-identical, and only
          // a genuine data change rewrites the file with a fresh stamp.
          const refreshed = (
            await Promise.all(
              cacheWrites.map(async ({ file, version, payload, extras }) => {
                const path = join(deps.dataDir, `${file}.json`);
                const prior = readPriorCache(path, file);
                if (prior !== null && priorPayloadEquals(prior, payload)) {
                  return null;
                }
                await writeJson(
                  path,
                  {
                    metadata: { schema_version: version, last_updated: lastUpdated, ...extras },
                    ...payload,
                  },
                  { signal: controller.signal },
                );
                return file;
              }),
            )
          ).filter((f): f is CacheFile => f !== null);
          // A1 fix: if the outer timeout fired during the cache writes,
          // bail before writing the commit marker. Without this guard the
          // scheduler.json could land after error_state.json was written,
          // producing contradictory on-disk markers (curator confusion).
          if (controller.signal.aborted) return abortedResult();

          // Commit-marker LAST per ADR-0011.
          phase = "writing_scheduler";
          await writeJson(
            join(deps.dataDir, ".scheduler.json"),
            {
              schema_version: SCHEDULER_SCHEMA_VERSION,
              last_sync_at: lastUpdated,
              next_sync_at: new Date(now().getTime() + scheduledIntervalMs).toISOString(),
            },
            { signal: controller.signal },
          );

          // error_state.json lifecycle, AFTER the commit marker (ADR-0011
          // commit-marker-last) so a curator reading mid-sync never observes a
          // scheduler-fresh + error_state-present contradiction. Soft warnings
          // record a non-blocking warn_only state; a fully-clean sync clears
          // any error_state left by a prior failed/soft run.
          if (gateResult.warnings.length > 0) {
            await writeErrorState(
              deps.dataDir,
              {
                step: "gate_warnings",
                detail: gateResult.warnings.map((w) => `${w.step}: ${w.detail}`).join("; "),
                mitigation: "warn_only",
              },
              { write: writeJson, signal: controller.signal },
            );
          } else {
            await clearError(deps.dataDir, { signal: controller.signal });
          }

          return {
            kind: "ran",
            lastSyncAt: lastUpdated,
            refreshed,
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
          // No signal here: this write runs AFTER controller.abort() and is the authoritative timeout record. Threading the (already-aborted) signal would make the abort-aware helper skip its rename and drop the record entirely.
          await writeErrorState(
            deps.dataDir,
            {
              step: "outer_timeout",
              phase,
              detail: `runSync exceeded ${outerTimeoutMs}ms during ${phase} phase`,
              ...(cycleBlockCoaching
                ? ({ mitigation: "block_coaching" } as const)
                : priorBlockCoaching(deps.dataDir)),
            },
            { write: writeJson },
          );
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
    } catch (err) {
      // The mutex body re-throws an unguarded error (e.g. a gate or cache-write
      // throw) out of `runExclusive`. The ticket's invariant is that EVERY tick
      // leaves exactly one history line, so stamp a `failed` line before letting
      // the throw propagate — otherwise a disk error mid-write would erase its
      // own evidence, the exact failure mode this trail exists to capture.
      emit("failed", "unexpected_error");
      throw err;
    }

    if (mutexResult.kind === "timeout") {
      return emitOutcome({ kind: "skipped", reason: "mutex_held" });
    }

    const result = mutexResult.value;
    if (result.kind === "ran" && opts.caller === "/sync" && opts.chatId !== undefined) {
      deps.cooldown.record(opts.chatId);
    }
    return emitOutcome(result);
  };
}
