/**
 * A logical instant supplied by the CALLER (the artifact's own time — an
 * activity start, a file's creation time, or a payload's snapshot time),
 * NEVER wall-clock. The archive path shard derives from this, so archiving the
 * same content is a pure, idempotent function of (bytes, instant): re-archiving
 * always maps to the same directory and the same content address. Reading
 * wall-clock here would let the same artifact land under two shards over time
 * and break content dedup.
 */
export interface ArchiveInstant {
  /** Epoch SECONDS, UTC. The yyyy/mm shard is derived in UTC from this. */
  readonly epochSeconds: number;
}

export interface ArchiveWriteResult {
  /** Lowercase-hex SHA-256 content address (64 chars). */
  readonly address: string;
  /** archiveRoot-relative POSIX path the artifact occupies. */
  readonly relPath: string;
  /** True when the content was already present and the write was skipped. */
  readonly deduped: boolean;
}

/**
 * The immutable, content-addressed raw archive — the athlete's source of
 * truth. Its write methods are the FIRST sink in any ingest path: every pull
 * MUST write its payload here before any derived store row is written
 * (archive-first is a hard ordering invariant, a direct dependency of
 * deterministic rebuild). The archive is append-only and content-addressed:
 * this interface exposes NO deletion, mutation, prune, or update method by
 * design. Do not add one.
 */
export interface ArchiveManager {
  /**
   * Archive raw artifact bytes (FIT/TCX/GPX/…), content-addressed on the raw
   * bytes, at `<yyyy>/<mm>/<address>.<ext>`. Archive-first sink; idempotent by
   * content address.
   */
  writeArtifact(
    bytes: Uint8Array,
    ext: string,
    when: ArchiveInstant,
  ): Promise<ArchiveWriteResult>;
  /**
   * Archive an API sync payload as a gzipped canonical-JSON snapshot,
   * content-addressed on the COMPRESSED bytes, at `<yyyy>/<mm>/<address>.json.gz`.
   * Archive-first sink; idempotent by content address.
   */
  writeSnapshot(payload: unknown, when: ArchiveInstant): Promise<ArchiveWriteResult>;
  /**
   * Route bytes an ingest path could not parse into `quarantine/<address>.<ext>`
   * with a durable reason sidecar. Never silently dropped.
   */
  quarantine(bytes: Uint8Array, ext: string, reason: string): Promise<ArchiveWriteResult>;
  /** Read raw artifact bytes back by archiveRoot-relative path. */
  readArtifact(relPath: string): Promise<Uint8Array>;
  /** Read + gunzip + parse a snapshot back to its value by archiveRoot-relative path. */
  readSnapshot(relPath: string): Promise<unknown>;
  /** True when an archiveRoot-relative path exists on disk. */
  has(relPath: string): Promise<boolean>;
}
