import type { SyncResult } from "./sync/run-sync.js";
import type { LatestJson } from "./schemas/latest.js";

/**
 * Channel-facing input for `ReferenceServices.runSync`. Narrows the internal
 * `RunSyncOpts` so channels cannot set operator/curator-mode flags
 * (`forceFresh`, `extendRetentionUntil`, `caller`). The runtime adapter in
 * `runtime.ts` maps `RunSyncRequest` → internal opts with `caller: "/sync"`.
 */
export interface RunSyncRequest {
  readonly chatId: string;
}

/**
 * Outcome of `maybeRefreshIfStale()`. Discriminated union for symmetry with
 * `SyncResult` (PR D) — Wave 5's curator dispatches on `kind` rather than
 * checking for a string sentinel:
 *
 *   - `fresh` — `latest.json`'s freshness band is "fresh"; no sync was run.
 *   - `synced` — freshness band crossed the "stale" or "critical" threshold;
 *                a lazy `runSync({ caller: "lazy" })` was fired and produced
 *                the embedded `SyncResult`.
 *
 * Wave 1b stub returns `{ kind: "fresh" }` unconditionally; Wave 5's curator
 * fills the body with the freshness-band check and lazy-fire dispatch.
 */
export type StaleCheckResult =
  | { readonly kind: "fresh" }
  | { readonly kind: "synced"; readonly result: SyncResult };

/**
 * Service-aggregate contract that Reference exposes to downstream channels.
 * Owned by the Reference layer per ADR-0010 — channels import this; Reference
 * does not import from channels.
 */
export interface ReferenceServices {
  readonly runSync: (req: RunSyncRequest) => Promise<SyncResult>;
  readonly loadLatest: () => LatestJson | null;
  /**
   * Wave 5 / F19 fills. Curator calls this at turn start when `latest.json`'s
   * freshness band is "stale" or "critical" — the lazy-fire path that
   * complements scheduled syncs. Lazy-fired runSyncs share the mutex,
   * cooldown, and outer-timeout discipline of scheduled syncs (per ADR-0011).
   *
   * Wave 1b stub: returns `{ kind: "fresh" }`. Declaring the seam now means
   * Wave 5 is a body-only PR (no interface change, no curator/channel
   * scrambling), and any new channel added in the meantime will see the
   * full contract instead of a half-shape.
   */
  readonly maybeRefreshIfStale: () => Promise<StaleCheckResult>;
}
