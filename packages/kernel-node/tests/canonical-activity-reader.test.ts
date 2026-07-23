import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCanonicalActivityReader, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { importFilesWithReport } from "../src/ingest/import-files.js";
import { openReadonlySqliteStorage, openSqliteStorage } from "../src/sqlite/index.js";

const roots = new Set<string>();
const fixture = (name: string) => resolve(`packages/kernel-node/tests/fixtures/ingest/${name}`);

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

async function importedStore(
  inputPaths: readonly string[] = [fixture("triathlon-multisport.fit")],
) {
  const root = mkdtempSync(join(tmpdir(), "canonical-reader-"));
  roots.add(root);
  const databasePath = join(root, "store.sqlite");
  const writer = openSqliteStorage(databasePath);
  await runMigrations(writer, MIGRATIONS);
  await importFilesWithReport({
    inputPaths,
    archiveDir: join(root, "archive"),
    store: writer,
  });
  return { databasePath, writer };
}

async function canonicalFixtureSnapshot(
  databasePath: string,
  activityId?: string,
  channels?: readonly string[],
) {
  const store = openReadonlySqliteStorage(databasePath);
  try {
    const reader = createCanonicalActivityReader(store);
    const page = await reader.listActivities({
      start: "1998-07-01",
      end: "1998-07-31",
      limit: 20,
    });
    const selectedId = activityId ?? page.activities.find(({ sport }) => sport === "cycling")!.id;
    return {
      page,
      detail: await reader.getActivity({ id: selectedId }),
      streams: await reader.getStreams({
        id: selectedId,
        channels: channels ?? ["time", "power", "heart_rate", "cadence"],
      }),
    };
  } finally {
    await store.close();
  }
}

describe("canonical activity reader with real SQLite", () => {
  it("reads multisport sessions, transitions, laps, and streams identically after reopen", async () => {
    const { databasePath, writer } = await importedStore();
    try {
      const cycling = await writer.get("SELECT session_key FROM session WHERE sport='cycling'");
      const activityId = String(cycling!.session_key);
      const channels = (
        await writer.all("SELECT channel FROM stream WHERE session_key=? ORDER BY channel", [
          activityId,
        ])
      ).map((row) => String(row.channel));

      const first = await canonicalFixtureSnapshot(databasePath, activityId, channels);
      expect(first.page.activities).toHaveLength(5);
      expect(first.page.activities.map(({ sessionSequence }) => sessionSequence)).toEqual([
        4, 3, 2, 1, 0,
      ]);
      expect(first.page.activities.every(({ isMultisport }) => isMultisport)).toBe(true);
      expect(
        first.page.activities.filter(({ isTransition }) => isTransition).map(({ sport }) => sport),
      ).toEqual(["transition", "transition"]);
      expect(first.detail?.laps.length).toBeGreaterThan(0);
      expect(Object.keys(first.streams?.channels ?? {})).toEqual(channels);
      expect(channels.length).toBeGreaterThan(0);

      const bytesBeforeClose = JSON.stringify(first);
      await writer.close();
      const reopened = await canonicalFixtureSnapshot(databasePath, activityId, channels);
      expect(JSON.stringify(reopened)).toBe(bytesBeforeClose);
    } catch (error) {
      await writer.close().catch(() => undefined);
      throw error;
    }
  });

  it("shows one complete committed version across a writer transaction", async () => {
    const { databasePath, writer } = await importedStore();
    const readonly = openReadonlySqliteStorage(databasePath);
    try {
      const selected = await writer.get(
        `SELECT s.session_key
FROM session AS s
WHERE EXISTS (SELECT 1 FROM lap AS l WHERE l.session_key = s.session_key)
ORDER BY s.session_key
LIMIT 1`,
      );
      const activityId = String(selected!.session_key);
      const reader = createCanonicalActivityReader(readonly);
      const before = await reader.getActivity({ id: activityId });
      expect(before?.laps.length).toBeGreaterThan(0);

      await writer.exec("BEGIN IMMEDIATE");
      await writer.run("UPDATE session SET distance_m=? WHERE session_key=?", [
        12_345.5,
        activityId,
      ]);
      await writer.run("UPDATE lap SET distance_m=? WHERE session_key=?", [1_234.5, activityId]);
      expect(await reader.getActivity({ id: activityId })).toEqual(before);
      await writer.exec("COMMIT");

      const after = await reader.getActivity({ id: activityId });
      expect(after?.distanceMeters).toBe(12_345.5);
      expect(after?.laps.every(({ distanceMeters }) => distanceMeters === 1_234.5)).toBe(true);
    } finally {
      await readonly.close();
      await writer.close();
    }
  });

  it("reports unsupported and corrupt persisted streams as typed decode failures", async () => {
    const { databasePath, writer } = await importedStore();
    const readonly = openReadonlySqliteStorage(databasePath);
    try {
      const selected = await writer.get(
        "SELECT stream_key,session_key,channel,encoding FROM stream ORDER BY stream_key LIMIT 1",
      );
      const streamKey = String(selected!.stream_key);
      const activityId = String(selected!.session_key);
      const channel = String(selected!.channel);
      const encoding = String(selected!.encoding);
      const reader = createCanonicalActivityReader(readonly);

      await writer.run("UPDATE stream SET encoding='unsupported' WHERE stream_key=?", [streamKey]);
      await expect(reader.getStreams({ id: activityId, channels: [channel] })).rejects.toEqual(
        expect.objectContaining({
          name: "CanonicalActivityReadError",
          code: "stream_decode_failed",
        }),
      );

      await writer.run("UPDATE stream SET encoding=?,data=? WHERE stream_key=?", [
        encoding,
        new Uint8Array([1]),
        streamKey,
      ]);
      await expect(reader.getStreams({ id: activityId, channels: [channel] })).rejects.toEqual(
        expect.objectContaining({
          name: "CanonicalActivityReadError",
          code: "stream_decode_failed",
        }),
      );
    } finally {
      await readonly.close();
      await writer.close();
    }
  });

  it("caps lap rows with a real SQLite sentinel read", async () => {
    const { databasePath, writer } = await importedStore();
    try {
      const selected = await writer.get(
        "SELECT session_key FROM session ORDER BY session_key LIMIT 1",
      );
      const activityId = String(selected!.session_key);
      await writer.run("DELETE FROM lap WHERE session_key=?", [activityId]);
      await writer.run(
        `WITH RECURSIVE seq(x) AS (
  SELECT 0
  UNION ALL
  SELECT x + 1 FROM seq WHERE x < 10000
)
INSERT INTO lap (
  lap_key, session_key, lap_seq, start_utc, elapsed_s, timer_s, distance_m, summary_json
)
SELECT printf('%064x', x + 1), ?, x, NULL, NULL, NULL, NULL, NULL
FROM seq`,
        [activityId],
      );
      const readonly = openReadonlySqliteStorage(databasePath);
      try {
        await expect(
          createCanonicalActivityReader(readonly).getActivity({ id: activityId }),
        ).rejects.toEqual(expect.objectContaining({ code: "invalid_row" }));
      } finally {
        await readonly.close();
      }
    } finally {
      await writer.close();
    }
  });

  it("projects oversized text to a small invalid sentinel before rows reach JavaScript", async () => {
    const { databasePath, writer } = await importedStore();
    try {
      const selected = await writer.get(
        "SELECT session_key FROM session ORDER BY session_key LIMIT 1",
      );
      const activityId = String(selected!.session_key);
      const marker = `oversized-sport-marker-${"x".repeat(256)}`;
      await writer.run("UPDATE session SET sport=? WHERE session_key=?", [marker, activityId]);
      const readonly = openReadonlySqliteStorage(databasePath);
      const captured: unknown[] = [];
      try {
        const reader = createCanonicalActivityReader({
          async all(sql, params = []) {
            const rows = await readonly.all(sql, params);
            captured.push(rows);
            return rows;
          },
        });
        await expect(reader.getActivity({ id: activityId })).rejects.toEqual(
          expect.objectContaining({ code: "invalid_row" }),
        );
        expect(JSON.stringify(captured)).not.toContain("oversized-sport-marker");
      } finally {
        await readonly.close();
      }
    } finally {
      await writer.close();
    }
  });

  it("keeps every committed ingest fixture below the reader stream caps", async () => {
    const manifest = JSON.parse(readFileSync(fixture("manifest.json"), "utf8")) as {
      readonly files: readonly { readonly path: string }[];
    };
    const { writer } = await importedStore(manifest.files.map(({ path }) => resolve(path)));
    try {
      const maxima = await writer.get(
        `SELECT max(n) AS max_n, max(length(data)) AS max_blob_bytes
FROM stream`,
      );
      const perSession = await writer.get(
        `SELECT max(total_n) AS max_total_n
FROM (
  SELECT sum(n) AS total_n
  FROM stream
  GROUP BY session_key
)`,
      );
      expect(Number(maxima!.max_n)).toBeLessThanOrEqual(1_000_000);
      expect(Number(maxima!.max_blob_bytes)).toBeLessThanOrEqual(16 * 1_024 * 1_024);
      expect(Number(perSession!.max_total_n)).toBeLessThanOrEqual(4_000_000);
    } finally {
      await writer.close();
    }
  });
});
