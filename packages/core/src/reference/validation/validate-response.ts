/**
 * Reference layer — Layer-2 LLM-output validator.
 *
 * Pure functions only (no LLM, no IO). Parses the `---meta---` block an athlete
 * reply carries, walks dot-paths into the latest snapshot, and asserts every
 * cited number/string the reply claims actually exists in the data read this
 * turn. The `RecommendationMetadata` contract ports from the Reference layer's
 * upstream protocol. See `NOTICE.md` for license attribution.
 */
import { createHash } from "node:crypto";
import {
  RecommendationMetadataSchema,
  type RecommendationMetadata,
} from "./recommendation-metadata.js";
import type { LatestJson } from "../schemas/latest.js";

export type Layer2Mode = "off" | "observe" | "enforce";

/**
 * Default Layer-2 mode: validate and flag, never retry. The caller passes any
 * operator override through; absent one, validation observes without retrying.
 */
export const DEFAULT_LAYER_2_MODE: Layer2Mode = "observe";

export type ValidationCheck =
  | "metadata_schema" // RecommendationMetadataSchema.safeParse failed
  | "citation_source" // a cited field is absent from the snapshot
  | "citation_value"; // a cited value mismatches the snapshot (beyond ±0.01)

export interface ValidationFailure {
  readonly check: ValidationCheck;
  readonly detail: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly failures: readonly ValidationFailure[];
}

const META_DELIMITER = "---meta---";

function responseHash(response: string): string {
  return createHash("sha256").update(response).digest("hex").slice(0, 16);
}

/**
 * Splits a reply on the literal `---meta---` delimiter line and returns the
 * LAST block parsed as JSON. When the reply carries more than one block it
 * warns with the response hash (the agent should emit exactly one). Returns
 * null when there is no block or the final block is not valid JSON.
 */
export function parseMetaBlock(
  response: string,
): { metadataJson: unknown; blockCount: number } | null {
  const parts = response.split(new RegExp(`^${META_DELIMITER}\\s*$`, "m"));
  // First part is the prose before any delimiter; each subsequent part is a
  // candidate metadata block.
  const blocks = parts.slice(1);
  if (blocks.length === 0) return null;

  if (blocks.length > 1) {
    console.warn(
      `Reference: reply carried ${blocks.length} ---meta--- blocks (expected 1); using the last. response=${responseHash(response)}`,
    );
  }

  const last = blocks[blocks.length - 1];
  try {
    return { metadataJson: JSON.parse(last), blockCount: blocks.length };
  } catch {
    return null;
  }
}

/**
 * lodash-get-style dot-path walk. Returns undefined on any null/undefined hop
 * or a missing key.
 */
export function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

/**
 * Asserts every citation in `metadata` resolves to a matching value in the
 * snapshot. Numbers compare within a ±0.01 tolerance; strings/enums compare
 * strictly. Evaluates ALL checks and returns one failure per miss, each tagged
 * with its check identity, so the offline per-lens gate can read each lens's
 * verdict. The one short-circuit: a schema-parse failure leaves the citations
 * unparseable, so the per-citation checks have nothing to run on.
 */
export function validateRecommendation(
  _response: string,
  metadata: unknown,
  snapshot: LatestJson,
): ValidationResult {
  const parsed = RecommendationMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return {
      ok: false,
      failures: [
        {
          check: "metadata_schema",
          detail: `Metadata failed schema validation: ${parsed.error.message}`,
        },
      ],
    };
  }

  const meta: RecommendationMetadata = parsed.data;
  const failures: ValidationFailure[] = [];
  for (const citation of meta.citations) {
    const actual = getByPath(snapshot, citation.field);
    if (actual === undefined) {
      failures.push({
        check: "citation_source",
        detail: `Citation source missing: ${citation.field} not found in snapshot.`,
      });
      continue;
    }

    if (!valuesMatch(actual, citation.value)) {
      failures.push({
        check: "citation_value",
        detail: `Citation mismatch: cited ${citation.field}=${String(citation.value)}, snapshot has ${String(actual)}.`,
      });
    }
  }

  return { ok: failures.length === 0, failures };
}

function valuesMatch(actual: unknown, cited: unknown): boolean {
  // Apply the ±0.01 numeric tolerance only when BOTH sides are real numbers.
  // CitationSchema.value is `unknown`, and Number() coerces false/null/"" to 0,
  // so without this typeof guard a snapshot (or cited) false/null/"" would
  // spuriously satisfy a 0 citation. Anything non-numeric — strings, enums,
  // booleans, null — compares strictly.
  if (typeof actual === "number" && typeof cited === "number") {
    if (Number.isFinite(actual) && Number.isFinite(cited)) {
      return Math.abs(actual - cited) <= 0.01;
    }
  }
  return actual === cited;
}
