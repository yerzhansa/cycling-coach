import { escapeHtmlText } from "../../channels/html-escape.js";
import {
  SNAPSHOT_DOCUMENT_THRESHOLD_BYTES,
  SNAPSHOT_DOCUMENT_THRESHOLD_CHUNKS,
} from "../freshness.js";
import type { LatestJson } from "../schemas/latest.js";

const TELEGRAM_MAX_CHUNK = 4096;
// Each chunk is a code fence the Telegram HTML path renders as an escaped
// <pre> block (the snapshot reply runs every chunk through markdownToTelegramHtml).
const FENCE_OPEN = "```\n";
const FENCE_CLOSE = "\n```";
// Room the rendered `<pre>${escapeHtmlText(body)}</pre>` leaves for the body.
// The trailing `-1` reserves the leading `\n` of FENCE_CLOSE: FENCE_RE captures
// `slice + "\n"` as the fence body, so the restored <pre> carries one extra char
// the `<pre></pre>` overhead alone doesn't account for.
const RENDERED_BUDGET = TELEGRAM_MAX_CHUNK - "<pre></pre>".length - 1;

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
      /** Same body re-chunked, for the handler's document→chunks fall-through. */
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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

// Each emitted chunk is a code fence the HTML path restores as
// `<pre>${escapeHtmlText(body)}</pre>`. Budget by the RENDERED length, not the
// raw length: a slice dense with `& < >` expands under escaping (`&`→`&amp;` is
// +4), so a raw-length budget could render a <pre> past Telegram's 4096 limit,
// and the converter's own chunker would then re-split it — breaking the 1:1
// raw→sent mapping the snapshot retry relies on. Growing the slice until the
// rendered <pre> would overflow guarantees one sub-chunk out per raw chunk.
function splitIntoChunks(body: string): readonly string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    let rendered = 0;
    let j = i;
    while (j < body.length) {
      const next = escapeHtmlText(body[j]).length;
      if (rendered + next > RENDERED_BUDGET) break;
      rendered += next;
      j++;
    }
    // Don't cut between the halves of a surrogate pair (but always make progress).
    if (j > i + 1 && j < body.length && isHighSurrogate(body.charCodeAt(j - 1))) j--;
    // A single char can never exceed the budget, so j always advances past i.
    out.push(`${FENCE_OPEN}${body.slice(i, j)}${FENCE_CLOSE}`);
    i = j;
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
