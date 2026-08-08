# @enduragent/kernel

## 0.1.0

### Minor Changes

- 10c6d16: Add read-only local bundle projection for the Reference layer.

### Patch Changes

- 8ac6eec: Record one store-level owner fingerprint from the resolved intervals.icu athlete identifier at sync time, compare it read-only before credential saves, allow saves when the comparison is unavailable, and keep credential rotation independent from account ownership.
- a6f259c: Add resumable incremental activity-history preparation and materialization while retaining the full Reference layer rebuild as an invariant oracle. Internal operator infrastructure; ships nothing to athletes.
- ec24061: User-facing: Prevent ambiguous duplicate activity streams from producing misleading training analysis.
- 5428c22: Keep Reference layer projections cycling-only while retaining athlete-wide wellness and cycling FTP history. Internal infrastructure; ships nothing to athletes.
- 0ab935f: Add a trusted canonical-activity resolver and revision key for bounded ride analysis.
- 42c6efa: Decode FIT artifacts into deterministic local-store rows with content-derived
  keys, identity-preserving developer fields, aligned stream blobs,
  archive-first persistence, and byte-identical re-ingest verification.
- 517a34f: Add the Reference layer intervals.icu source with archive-first activity, stream,
  wellness, sport-setting, and FIT hydration plus deterministic activity revisions.
  Private infrastructure; ships nothing to athletes.
- c122f29: Invalidate cached session and date metrics for both replaced and incoming
  activity scopes.
- 111261c: Add deterministic dedup planning, authored confirmations, and stable import reporting.
- 4e996bc: Add the content-addressed raw-archive manager to the pure kernel and its Node
  host adapter: content-addressed artifact writes, gzipped canonical-JSON payload
  snapshots, quarantine routing for unparseable inputs, and a structurally
  never-delete, archive-first write surface behind the injected Crypto and
  FileSystem ports.
- 66fc866: Add the node:sqlite Storage-port driver, the pure repository-port layer
  (anchor-history insert-if-absent / read-current, raw_file and source_record
  upserts), and the INV-2 canonical ordered-logical-dump harness with an
  engine-stable float serializer.
- b8a8ef0: Add the local-first athlete store's schema v1 as a single numbered migration
  (Domains A–H) shipped bundled-as-string behind an ordered migration list on a
  new store/migrations subpath, with a migration-executes-and-is-FK-consistent
  test gate. Private-package infrastructure; ships nothing to users.
- 0b73876: Add strict TCX/GPX fallback parsing, deterministic quarantine reasons, and
  quality-ranked whole-concern arbitration that preserves higher-quality data.
- 00ee9f4: Persist per-source synchronization failures and keep mixed API and FIT activity presentations deterministic.
- 68821e7: Add immutable Reference capture sidecars with replayable endpoint evidence and exact live-fetch ordering. Private infrastructure; ships nothing to athletes.
- 9a7961c: Relocate portable Reference layer and concurrency sources into the kernel,
  preserving core consumers through compatibility shims and explicit subpaths.
- ded6067: Add opt-in repair-fixer settings with deterministic derived-state rebuilds. Internal infrastructure; ships nothing to athletes.
- 336462d: Add atomic request reservations for bounded analytics refreshes.
- fd9cd3a: Add the sync-source contract, deterministic source revision state, and opt-in Retry-After lower-bound handling while preserving existing capped retries. Internal infrastructure; ships nothing to athletes.
