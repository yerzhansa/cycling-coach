import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AnchorSeedRow,
  type AnchorSeederStore,
  epochSecondsFromDate,
  seedFtpHistory,
} from "../src/home/anchor-seeder.js";

function makeFakeAnchorStore() {
  const seen = new Set<string>();
  const rows: AnchorSeedRow[] = [];
  const store: AnchorSeederStore = {
    async insertAnchorIfAbsent(row) {
      const key = `${row.sport}|${row.anchorType}|${row.validFrom}`;
      if (seen.has(key)) return false;
      seen.add(key);
      rows.push(row);
      return true;
    },
  };
  return { store, rows };
}

const VALID_METADATA = { schema_version: "1", last_updated: "2021-01-01T00:00:00Z" };

describe("seedFtpHistory", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "legacy-coach-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeRaw(raw: string): void {
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "ftp_history.json"), raw, "utf8");
  }

  function writeHistory(contents: unknown): void {
    writeRaw(JSON.stringify(contents));
  }

  it("(absent) no file → no-op", async () => {
    const { store, rows } = makeFakeAnchorStore();
    const report = await seedFtpHistory({ legacyCoachHome: home, store });
    expect(report).toEqual({
      source: "absent",
      entriesRead: 0,
      inserted: 0,
      deduped: 0,
      skippedMalformed: 0,
    });
    expect(rows).toHaveLength(0);
  });

  it("(empty) real-install case → clean no-op", async () => {
    writeHistory({ metadata: VALID_METADATA, entries: [] });
    const { store, rows } = makeFakeAnchorStore();
    const report = await seedFtpHistory({ legacyCoachHome: home, store });
    expect(report).toEqual({
      source: "empty",
      entriesRead: 0,
      inserted: 0,
      deduped: 0,
      skippedMalformed: 0,
    });
    expect(rows).toHaveLength(0);
  });

  it("(populated) fixture-driven happy path", async () => {
    writeHistory({
      metadata: VALID_METADATA,
      entries: [
        { date: "2021-03-15", ftp: 250, source: "estimate" },
        { date: "2022-06-01", ftp: 265, source: "test" },
      ],
    });
    const { store, rows } = makeFakeAnchorStore();
    const report = await seedFtpHistory({ legacyCoachHome: home, store });
    expect(report).toEqual({
      source: "populated",
      entriesRead: 2,
      inserted: 2,
      deduped: 0,
      skippedMalformed: 0,
    });
    expect(rows[0]).toEqual({
      sport: "cycling",
      anchorType: "ftp",
      value: 250,
      unit: "W",
      validFrom: 1615766400,
      source: "estimate",
      confidence: "platform",
      provenance: "sync",
    });
    expect(rows[1]).toEqual({
      sport: "cycling",
      anchorType: "ftp",
      value: 265,
      unit: "W",
      validFrom: epochSecondsFromDate("2022-06-01"),
      source: "test",
      confidence: "manual",
      provenance: "sync",
    });
  });

  it("(idempotent) run twice → zero duplicates", async () => {
    writeHistory({
      metadata: VALID_METADATA,
      entries: [
        { date: "2021-03-15", ftp: 250, source: "estimate" },
        { date: "2022-06-01", ftp: 265, source: "test" },
      ],
    });
    const { store, rows } = makeFakeAnchorStore();
    const first = await seedFtpHistory({ legacyCoachHome: home, store });
    expect(first.inserted).toBe(2);
    const second = await seedFtpHistory({ legacyCoachHome: home, store });
    expect(second).toEqual({
      source: "populated",
      entriesRead: 2,
      inserted: 0,
      deduped: 2,
      skippedMalformed: 0,
    });
    expect(rows).toHaveLength(2);
  });

  it("(malformed) skip + report", async () => {
    writeHistory({
      metadata: VALID_METADATA,
      entries: [
        { date: "2021-03-15", ftp: 250, source: "estimate" },
        { date: "2021-04-01", source: "test" },
        { date: "2021-05-01", ftp: -1, source: "test" },
        { date: "2021-06-01", ftp: 3.5, source: "test" },
        { date: "2021-07-01", ftp: 200, source: "guess" },
        { date: 12345, ftp: 200, source: "test" },
      ],
    });
    const { store, rows } = makeFakeAnchorStore();
    const report = await seedFtpHistory({ legacyCoachHome: home, store });
    expect(report.inserted).toBe(1);
    expect(report.skippedMalformed).toBe(5);
    expect(report.deduped).toBe(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(250);
  });

  it("(epoch) date → UTC epoch seconds + unparseable date skipped", async () => {
    expect(epochSecondsFromDate("2021-03-15")).toBe(1615766400);
    expect(epochSecondsFromDate("not-a-date")).toBeNull();
    writeHistory({
      metadata: VALID_METADATA,
      entries: [
        { date: "2021-03-15", ftp: 250, source: "estimate" },
        { date: "not-a-date", ftp: 260, source: "test" },
      ],
    });
    const { store, rows } = makeFakeAnchorStore();
    const report = await seedFtpHistory({ legacyCoachHome: home, store });
    expect(report.inserted).toBe(1);
    expect(report.skippedMalformed).toBe(1);
    expect(rows[0]?.validFrom).toBe(1615766400);
  });

  it("(confidence) source → tier mapping", async () => {
    writeHistory({
      metadata: VALID_METADATA,
      entries: [
        { date: "2021-03-15", ftp: 250, source: "estimate" },
        { date: "2022-06-01", ftp: 265, source: "test" },
      ],
    });
    const { store, rows } = makeFakeAnchorStore();
    await seedFtpHistory({ legacyCoachHome: home, store });
    const estimateRow = rows.find((r) => r.source === "estimate");
    const testRow = rows.find((r) => r.source === "test");
    expect(estimateRow?.confidence).toBe("platform");
    expect(testRow?.confidence).toBe("manual");
  });

  it("(unreadable) corrupt file → no-op, no throw", async () => {
    writeRaw("{ not valid json");
    const first = makeFakeAnchorStore();
    const r1 = await seedFtpHistory({ legacyCoachHome: home, store: first.store });
    expect(r1).toEqual({
      source: "unreadable",
      entriesRead: 0,
      inserted: 0,
      deduped: 0,
      skippedMalformed: 0,
    });
    expect(first.rows).toHaveLength(0);

    writeHistory({ entries: [] });
    const second = makeFakeAnchorStore();
    const r2 = await seedFtpHistory({ legacyCoachHome: home, store: second.store });
    expect(r2.source).toBe("unreadable");
    expect(second.rows).toHaveLength(0);
  });

  it("(log-once) the summary sink is called at most once", async () => {
    writeHistory({
      metadata: VALID_METADATA,
      entries: [{ date: "2021-03-15", ftp: 250, source: "estimate" }],
    });
    const { store } = makeFakeAnchorStore();
    const lines: string[] = [];
    await seedFtpHistory({ legacyCoachHome: home, store, log: (line) => lines.push(line) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("source=populated");
  });
});
