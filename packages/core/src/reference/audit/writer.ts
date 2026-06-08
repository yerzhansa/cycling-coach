/**
 * Reference layer — audit-log writer.
 *
 * Appends one compact JSONL line per coaching reply to `<data>/.audit.jsonl`
 * via `open(path, "a")` (O_APPEND). Best-effort: never throws, so a full disk
 * or a permission error can never break the reply path. Per-failure warns; a
 * one-time `console.error` escalation fires after 10 cumulative failures in a
 * session. Ports from the Reference layer's upstream protocol. See `NOTICE.md`
 * for license attribution.
 */
import { open, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { referenceDataDir } from "../paths.js";
import {
  type AuditLogEntry,
  type RecommendationMetadata,
} from "../validation/recommendation-metadata.js";

let auditWriteFailureCount = 0;
let escalated = false;

export async function writeAuditEntry(
  binaryName: string,
  entry: AuditLogEntry,
): Promise<void> {
  const path = join(referenceDataDir(binaryName), ".audit.jsonl");
  const line = JSON.stringify(entry) + "\n";

  try {
    await mkdir(dirname(path), { recursive: true });
    const fh = await open(path, "a", 0o644);
    try {
      await fh.appendFile(line, "utf-8");
    } finally {
      await fh.close();
    }
  } catch (err) {
    handleFailure(err);
  }
}

function handleFailure(err: unknown): void {
  console.warn(`Reference: audit log write failed: ${formatError(err)}`);
  auditWriteFailureCount++;
  if (auditWriteFailureCount >= 10 && !escalated) {
    escalated = true;
    console.error(
      "Reference: audit log writer has failed 10 times this session — disk full or permission issue likely. Audit trail is being lost.",
    );
  }
}

export function computeResponseHash(
  responseText: string,
  metadata: RecommendationMetadata,
): string {
  return createHash("sha256")
    .update(responseText + JSON.stringify(metadata))
    .digest("hex")
    .slice(0, 16);
}

export function __resetAuditFailureState(): void {
  auditWriteFailureCount = 0;
  escalated = false;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
