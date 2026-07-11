import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FtpHistoryJsonSchema, FtpHistoryPointSchema } from "./ftp-history-schema.js";

export const LEGACY_DATA_SUBDIR = "data" as const;
export const FTP_HISTORY_FILENAME = "ftp_history.json" as const;

export interface AnchorSeedRow {
  readonly sport: "cycling";
  readonly anchorType: "ftp";
  readonly value: number;
  readonly unit: "W";
  readonly validFrom: number;
  readonly source: string;
  readonly confidence: "manual" | "platform";
  readonly provenance: "sync";
}

export interface AnchorSeederStore {
  /**
   * Insert one anchor_history row IFF no row already exists for the 3-column
   * key (sport, anchor_type, valid_from). Returns true if inserted, false if a
   * row with that key already existed. The implementation derives the row's
   * content-addressed primary key and leaves the source-class stamp columns
   * (device_id, hlc_physical_ms, hlc_counter, note) NULL. Idempotency is this
   * method's contract, not a schema UNIQUE constraint.
   */
  insertAnchorIfAbsent(row: AnchorSeedRow): Promise<boolean>;
}

export type FtpSeedSource = "absent" | "empty" | "populated" | "unreadable";

export interface FtpSeedReport {
  readonly source: FtpSeedSource;
  readonly entriesRead: number;
  readonly inserted: number;
  readonly deduped: number;
  readonly skippedMalformed: number;
}

export function epochSecondsFromDate(dateStr: string): number | null {
  const ms = Date.parse(dateStr);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export interface SeedFtpHistoryOptions {
  /** The legacy per-binary home root (the caller resolves it via the legacy per-binary home resolver in core; the seeder resolves no legacy home itself). The file read is <legacyCoachHome>/data/ftp_history.json. */
  readonly legacyCoachHome: string;
  readonly store: AnchorSeederStore;
  /** Optional single-line summary sink; called at most once. Defaults to a no-op. */
  readonly log?: (line: string) => void;
}

export async function seedFtpHistory(opts: SeedFtpHistoryOptions): Promise<FtpSeedReport> {
  const log = opts.log ?? (() => {});
  const finish = (report: FtpSeedReport): FtpSeedReport => {
    log(
      `ftp-history seed: source=${report.source} read=${report.entriesRead} inserted=${report.inserted} deduped=${report.deduped} skipped=${report.skippedMalformed}`,
    );
    return report;
  };

  const filePath = join(opts.legacyCoachHome, LEGACY_DATA_SUBDIR, FTP_HISTORY_FILENAME);

  if (!existsSync(filePath)) {
    return finish({ source: "absent", entriesRead: 0, inserted: 0, deduped: 0, skippedMalformed: 0 });
  }

  let parsed;
  try {
    const raw = readFileSync(filePath, "utf8");
    parsed = FtpHistoryJsonSchema.parse(JSON.parse(raw));
  } catch {
    return finish({ source: "unreadable", entriesRead: 0, inserted: 0, deduped: 0, skippedMalformed: 0 });
  }

  const entries = parsed.entries;
  if (entries.length === 0) {
    return finish({ source: "empty", entriesRead: 0, inserted: 0, deduped: 0, skippedMalformed: 0 });
  }

  let inserted = 0;
  let deduped = 0;
  let skippedMalformed = 0;

  for (const entry of entries) {
    const res = FtpHistoryPointSchema.safeParse(entry);
    if (!res.success) {
      skippedMalformed++;
      continue;
    }
    const validFrom = epochSecondsFromDate(res.data.date);
    if (validFrom === null) {
      skippedMalformed++;
      continue;
    }
    const row: AnchorSeedRow = {
      sport: "cycling",
      anchorType: "ftp",
      value: res.data.ftp,
      unit: "W",
      validFrom,
      source: res.data.source,
      confidence: res.data.source === "test" ? "manual" : "platform",
      provenance: "sync",
    };
    if (await opts.store.insertAnchorIfAbsent(row)) inserted++;
    else deduped++;
  }

  return finish({ source: "populated", entriesRead: entries.length, inserted, deduped, skippedMalformed });
}
