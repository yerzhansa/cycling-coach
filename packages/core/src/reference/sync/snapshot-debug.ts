// Adapted from CrankAddict/section-11 (MIT, 2026); see NOTICE.md.

import {
  SNAPSHOT_DOCUMENT_THRESHOLD_BYTES,
  SNAPSHOT_DOCUMENT_THRESHOLD_CHUNKS,
} from "../freshness.js";
import type { LatestJson } from "../schemas/latest.js";

const TELEGRAM_MAX_CHUNK = 4096;
// Wrap inside ```json ... ``` fences for readability; reserve overhead for the
// fences themselves so the body fits.
const FENCE_OPEN = "```json\n";
const FENCE_CLOSE = "\n```";
const FENCE_OVERHEAD = FENCE_OPEN.length + FENCE_CLOSE.length;
const BODY_BUDGET = TELEGRAM_MAX_CHUNK - FENCE_OVERHEAD;

const VALID_SECTIONS: readonly (keyof LatestJson)[] = [
  "athlete_profile",
  "current_status",
  "derived_metrics",
  "recent_activities",
  "planned_workouts",
  "wellness_data",
  "metadata",
];

export type SnapshotOutput =
  | { readonly kind: "chunks"; readonly chunks: readonly string[] }
  | {
      readonly kind: "document";
      readonly buffer: Buffer;
      readonly filename: string;
      /** Same body re-chunked, for the handler's document→chunks fall-through (F5). */
      readonly chunks: readonly string[];
    };

/**
 * Format `latest.json` for the operator's `/snapshot raw` debug command.
 * Returns either chunked Telegram-friendly markdown or a single-document
 * upload buffer when the dump exceeds the configured thresholds. The handler
 * dispatches on `kind` to call `ctx.reply` vs `bot.api.sendDocument`.
 */
export function formatSnapshotRaw(
  latest: LatestJson | null,
  section?: string,
): SnapshotOutput {
  if (latest === null) {
    return {
      kind: "chunks",
      chunks: [
        "Reference hasn't synced yet — try `/sync` first.",
      ],
    };
  }

  if (section !== undefined) {
    const key = section.toLowerCase();
    if (!VALID_SECTIONS.includes(key as keyof LatestJson)) {
      return {
        kind: "chunks",
        chunks: [
          `Unknown section: \`${section}\`.\n\nValid sections: ${VALID_SECTIONS.join(", ")}.`,
        ],
      };
    }
    const value = (latest as Record<string, unknown>)[key];
    return wrap(JSON.stringify(value, null, 2));
  }

  return wrap(JSON.stringify(latest, null, 2));
}

function wrap(body: string): SnapshotOutput {
  const totalBytes = Buffer.byteLength(body, "utf8");
  const chunks = splitIntoChunks(body);

  // Body containing "```" would close the outer ```json…``` Markdown fence
  // prematurely, producing a Telegram 400 (parse-mode error) or rendered
  // garbage. Force document mode in that case to side-step Markdown escaping
  // entirely. Realistic trigger: an athlete's intervals.icu activity name or
  // description that includes a code block (mirrored from Strava etc.).
  const containsFenceBreaker = body.includes("```");

  if (
    containsFenceBreaker ||
    totalBytes > SNAPSHOT_DOCUMENT_THRESHOLD_BYTES ||
    chunks.length > SNAPSHOT_DOCUMENT_THRESHOLD_CHUNKS
  ) {
    return asDocument(body, chunks);
  }
  return { kind: "chunks", chunks };
}

function splitIntoChunks(body: string): readonly string[] {
  const out: string[] = [];
  for (let i = 0; i < body.length; i += BODY_BUDGET) {
    const slice = body.slice(i, i + BODY_BUDGET);
    out.push(`${FENCE_OPEN}${slice}${FENCE_CLOSE}`);
  }
  return out;
}

function asDocument(body: string, chunks: readonly string[]): SnapshotOutput {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return {
    kind: "document",
    buffer: Buffer.from(body, "utf8"),
    filename: `snapshot-${ts}.json`,
    chunks,
  };
}
