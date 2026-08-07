import type { Row, SqlReadStore } from "./ports.js";

declare const providerActivityIdBrand: unique symbol;
export type TrustedProviderActivityId = string & {
  readonly [providerActivityIdBrand]: "intervals-icu-activity";
};

export type TrustedActivitySourceResolution =
  | {
      readonly kind: "resolved";
      readonly providerActivityId: TrustedProviderActivityId;
      readonly sourceRevision: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "not_found" | "ambiguous";
    };

export type ActivitySourceResolutionErrorCode = "invalid_input" | "invalid_row";

export class ActivitySourceResolutionError extends Error {
  readonly code: ActivitySourceResolutionErrorCode;

  constructor(code: ActivitySourceResolutionErrorCode) {
    super(`activity source resolution rejected: ${code}`);
    this.name = "ActivitySourceResolutionError";
    this.code = code;
  }
}

export interface TrustedActivitySourceResolver {
  resolve(input: {
    readonly canonicalActivityId: string;
  }): Promise<TrustedActivitySourceResolution>;
}

const HEX_ADDRESS = /^[0-9a-f]{64}$/;
const MAX_PROVIDER_ACTIVITY_ID_BYTES = 256;

function invalidInput(): never {
  throw new ActivitySourceResolutionError("invalid_input");
}

function invalidRow(): never {
  throw new ActivitySourceResolutionError("invalid_row");
}

function isSafeProviderActivityId(value: unknown): value is TrustedProviderActivityId {
  if (typeof value !== "string" || value.length === 0
    || new TextEncoder().encode(value).byteLength > MAX_PROVIDER_ACTIVITY_ID_BYTES) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return false;
  }
  return true;
}

function resolved(row: Row): TrustedActivitySourceResolution {
  if (!isSafeProviderActivityId(row.external_id)
    || typeof row.revision_id !== "string" || !HEX_ADDRESS.test(row.revision_id)) invalidRow();
  return {
    kind: "resolved",
    providerActivityId: row.external_id,
    sourceRevision: row.revision_id,
  };
}

/**
 * Resolve a renderer-safe canonical session ID to trusted provider authority.
 * The branded provider ID must stay inside daemon/main code; sourceRevision is
 * the stable cache invalidation key for remote analysis derived from this row.
 */
export function createTrustedActivitySourceResolver(
  store: Pick<SqlReadStore, "all">,
): TrustedActivitySourceResolver {
  return {
    async resolve(input) {
      if (input === null || typeof input !== "object"
        || typeof input.canonicalActivityId !== "string"
        || !HEX_ADDRESS.test(input.canonicalActivityId)) invalidInput();
      const rows = await store.all(`SELECT
  sr.external_id,
  c.revision_id
FROM session AS s
JOIN source_record AS sr ON sr.session_key = s.session_key
JOIN source_record_current AS c ON c.source_record_id = sr.id
JOIN source_record_revision AS r
  ON r.source_record_id = c.source_record_id AND r.revision_id = c.revision_id
JOIN source_artifact AS a ON a.artifact_key = r.artifact_key
WHERE s.session_key = ?
  AND sr.source = 'intervals-icu'
  AND a.source = 'intervals-icu'
  AND a.lane = 'activities'
  AND a.external_id = sr.external_id
ORDER BY sr.id COLLATE BINARY ASC
LIMIT 2`, [input.canonicalActivityId]);
      if (rows.length === 0) return { kind: "unavailable", reason: "not_found" };
      if (rows.length > 1) return { kind: "unavailable", reason: "ambiguous" };
      return resolved(rows[0]!);
    },
  };
}
