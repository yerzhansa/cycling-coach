/**
 * Reference layer — audit-log parser.
 *
 * Streams `<data>/.audit.jsonl` line-by-line and yields each entry that parses
 * cleanly under the current `AuditLogEntrySchema`. A version-switch reads
 * `schema_version` before the schema parse so future formats can be dispatched
 * without breaking this reader. Robust to manual file corruption: malformed
 * JSON and unknown-version lines are warned and skipped; a missing file yields
 * an empty iterable with no warning (missing is normal). Ports from the
 * Reference layer's upstream protocol. See `NOTICE.md` for license attribution.
 */
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { referenceDataDir } from "../paths.js";
import {
  AUDIT_SCHEMA_VERSION,
  AuditLogEntrySchema,
  type AuditLogEntry,
} from "../validation/recommendation-metadata.js";

export async function* parseAuditLog(
  binaryName: string,
): AsyncGenerator<AuditLogEntry> {
  const path = join(referenceDataDir(binaryName), ".audit.jsonl");
  if (!existsSync(path)) return;

  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line === "") continue;

    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      console.warn(
        `parseAuditLog: skipping malformed JSON line: ${line.slice(0, 80)}`,
      );
      continue;
    }

    const version = (obj as { schema_version?: unknown })?.schema_version;
    if (version !== AUDIT_SCHEMA_VERSION) {
      console.warn(
        `parseAuditLog: skipping unknown schema_version ${String(version)} (parser supports ${AUDIT_SCHEMA_VERSION})`,
      );
      continue;
    }

    const result = AuditLogEntrySchema.safeParse(obj);
    if (!result.success) {
      console.warn(
        `parseAuditLog: skipping line failing schema: ${result.error.message}`,
      );
      continue;
    }

    yield result.data;
  }
}
