// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

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
 * Service-aggregate contract that Reference exposes to downstream channels.
 * Owned by the Reference layer per ADR-0010 — channels import this; Reference
 * does not import from channels.
 */
export interface ReferenceServices {
  readonly runSync: (req: RunSyncRequest) => Promise<SyncResult>;
  readonly loadLatest: () => LatestJson | null;
}
