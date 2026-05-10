// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import type { RunSyncOpts, SyncResult } from "./sync/run-sync.js";
import type { LatestJson } from "./schemas/latest.js";

/**
 * Service-aggregate contract that Reference exposes to downstream channels.
 * Owned by the Reference layer per ADR-0010 — channels import this; Reference
 * does not import from channels.
 */
export interface ReferenceServices {
  readonly runSync: (opts: RunSyncOpts) => Promise<SyncResult>;
  readonly loadLatest: () => LatestJson | null;
}
