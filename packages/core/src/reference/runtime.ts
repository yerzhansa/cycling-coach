import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { AsyncMutex } from "../concurrency/mutex.js";
import { Cooldown } from "../concurrency/cooldown.js";
import { createRunSync } from "./sync/run-sync.js";
import { Scheduler } from "./sync/scheduler.js";
import { makeProductionFetcher } from "./sync/fetch-reference-data.js";
import { safeReadJson } from "../io/safe-read-json.js";
import { LatestJsonSchema, type LatestJson } from "./schemas/latest.js";
import { SYNC_COOLDOWN_MS, SCHEDULED_SYNC_INTERVAL_MS } from "./freshness.js";
import {
  assertDisjointCoverage,
  assertSubsetCoverage,
} from "./sport-adapter-invariants.js";
import type { FetchedReference } from "./sync/run-sync.js";
import type { ReferenceServices } from "./services.js";
import type { Sport } from "../sport.js";

/** Shared between runtime + tests so the strings stay in sync. */
export const INITIAL_SYNC_FAILED_LOG_PREFIX = "Reference: initial sync failed";

/**
 * Live, started Reference instance. Held by the binary entry-point
 * (`run-binary.ts`); channels see only `services`. The scheduler handle is
 * exposed for shutdown handlers and future operator-controlled lifecycle.
 */
export interface ReferenceRuntime {
  readonly services: ReferenceServices;
  readonly scheduler: Scheduler;
}

export interface BootstrapReferenceDeps {
  /** Binary's per-coach data root (e.g., `~/.cycling-coach/`). */
  readonly dataDir: string;
  readonly intervals: { readonly apiKey: string; readonly athleteId?: string };
  readonly sport: Sport;
  /** Inject a fetcher for tests. Defaults to `makeProductionFetcher`. */
  readonly fetchReferenceData?: (signal: AbortSignal) => Promise<FetchedReference>;
}

/**
 * Construct + start the Reference layer. Pins the init order per ADR-0011's
 * two-phase scheduler discipline:
 *
 *   1. Construct services (mutex, cooldown, runSync factory, scheduler — NO timer).
 *   2. Await first runSync (best-effort; failure logs but does not throw).
 *   3. `scheduler.start()` registers the periodic timer using the now-current
 *      `.scheduler.json` that step 2 just wrote.
 *
 * Reordering these is a correctness regression — the cold-start
 * tick-vs-first-sync race re-emerges. The behavioral test in
 * `reference-runtime.test.ts` asserts the timer registration happens AFTER
 * the first fetch resolves.
 */
export async function bootstrapReference(
  deps: BootstrapReferenceDeps,
): Promise<ReferenceRuntime> {
  // Validate adapter coverage before any side effect: a misconfigured adapter
  // array is a config error, not a transient one, so it must crash the boot
  // synchronously — no data dir, no scheduler timer, no fetch — rather than
  // degrade like a failed first sync would.
  const adapters = deps.sport.referenceAdapters?.() ?? [];
  assertDisjointCoverage(adapters);
  assertSubsetCoverage(adapters, deps.sport.intervalsActivityTypes);

  const referenceDataPath = join(deps.dataDir, "data");
  mkdirSync(referenceDataPath, { recursive: true, mode: 0o700 });

  const fetchReferenceData =
    deps.fetchReferenceData ??
    makeProductionFetcher({
      apiKey: deps.intervals.apiKey,
      athleteId: deps.intervals.athleteId,
    });

  const mutex = new AsyncMutex();
  const cooldown = new Cooldown();
  const runSyncInternal = createRunSync({
    dataDir: referenceDataPath,
    mutex,
    cooldown,
    cooldownWindowMs: SYNC_COOLDOWN_MS,
    fetchReferenceData,
  });
  const scheduler = new Scheduler({
    dataDir: referenceDataPath,
    runSync: runSyncInternal,
    intervalMs: SCHEDULED_SYNC_INTERVAL_MS,
  });

  // First runSync — best-effort. Failure writes `error_state.json` and we
  // continue with whatever cache (if any) is on disk; the scheduler's next
  // tick will retry.
  try {
    await runSyncInternal({ caller: "scheduled" });
  } catch (err) {
    console.warn(
      `${INITIAL_SYNC_FAILED_LOG_PREFIX} (${err instanceof Error ? err.message : String(err)}). Continuing with empty cache; lazy fallback will retry.`,
    );
  }

  scheduler.start();

  const services: ReferenceServices = {
    runSync: (req) => runSyncInternal({ caller: "/sync", chatId: req.chatId }),
    loadLatest: (): LatestJson | null =>
      safeReadJson<LatestJson>(join(referenceDataPath, "latest.json"), LatestJsonSchema),
    // Stub; the curator fills this (see ReferenceServices.maybeRefreshIfStale).
    maybeRefreshIfStale: () => Promise.resolve({ kind: "fresh" }),
  };

  return { services, scheduler };
}
