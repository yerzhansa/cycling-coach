import { describe, expect, it, vi } from "vitest";
import {
  createCoreToolsWithSportConfig,
  createStoreAthleteDataReader,
  formatStoreFreshness,
  type Config,
  type ReferenceRuntime,
  type Sport,
} from "@enduragent/core";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type { CanonicalActivityReader } from "@enduragent/kernel/store";
import type { IntervalsClient } from "intervals-icu-api";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoreRuntime } from "../src/store-runtime.js";
import { prepareStoreCoachComposition } from "../src/local-bot.js";

const config = {
  dataSource: "store",
  intervals: { apiKey: "synthetic", athleteId: "synthetic-athlete" },
  dataDir: "synthetic-data",
} as Config;
const sport = { intervalsActivityTypes: [], referenceAdapters: undefined } as unknown as Sport;

describe("local bot composition", () => {
  it("uses manual Reference mode, runs the initial paired window, then starts one outer scheduler", async () => {
    const runWindow = vi.fn(async () => ({ published: true })),
      startScheduler = vi.fn(),
      close = vi.fn(async () => {});
    const reader = { freshness: () => undefined };
    const runtime = {
      athleteData: reader,
      runWindow,
      startScheduler,
      close,
      attemptLedgerForRun: vi.fn(),
    } as unknown as StoreRuntime;
    const reference = {
      services: {},
      scheduler: { stop: vi.fn() },
      runScheduledOnce: vi.fn(),
    } as unknown as ReferenceRuntime;
    const bootstrap = vi.fn(async () => reference);
    const prepared = await prepareStoreCoachComposition(
      { config, sport },
      {
        env: { ENDURAGENT_HOME: "synthetic-home" },
        resolveHome: () => ({
          root: "synthetic-home",
          storeDir: "synthetic-store",
          archiveDir: "synthetic-archive",
          configDir: "synthetic-config",
        }),
        bootstrap,
        createRuntime: vi.fn(() => runtime),
      },
    );
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({ startScheduler: false }));
    expect(runWindow).toHaveBeenCalledTimes(1);
    expect(startScheduler).toHaveBeenCalledTimes(1);
    expect(prepared.athleteData).toBe(reader);
    await prepared.close?.();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps platform mode on the default composition path", async () => {
    await expect(
      prepareStoreCoachComposition({ config: { ...config, dataSource: "platform" }, sport }),
    ).resolves.toEqual({});
  });

  it("answers historical outage questions from canonical activities while snapshot freshness ages and bytes stay unchanged", async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "local-bot-outage-"));
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (() => {
        throw new Error("Network disabled for composition test");
      }) as typeof fetch;
      const paths = [
        "store.db",
        "archive.bin",
        "manifest.json",
        "legacy-cache.json",
        "credentials.env",
      ].map((name) => join(root, name));
      await Promise.all(
        paths.map((path, index) => writeFile(path, `sentinel-${index}\n`, { mode: 0o600 })),
      );
      const digest = async (path: string): Promise<string> =>
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      const before = await Promise.all(paths.map(digest));
      const snapshot: ProducedLocalBundle = {
        captureId: "12345678-1234-4123-8123-123456789abc",
        captureClock: {
          captureEpochMs: Date.parse("2023-09-11T00:00:00.000Z"),
          civilDateTime: "2023-09-11T00:00:00.000Z",
          calendarTimeZone: "UTC",
        },
        bundle: {
          athlete: { sportSettings: [] },
          wellness: [],
          ftpHistory: [],
          activities: [
            {
              id: 1,
              type: "Ride",
              start_date_local: "2019-06-01T08:00:00",
              moving_time: 1,
              elapsed_time: 1,
              distance: 100_000,
              icu_training_load: 180,
              icu_intensity: 78,
            },
            {
              id: 2,
              type: "Ride",
              start_date_local: "2022-07-02T08:00:00",
              moving_time: 1,
              elapsed_time: 1,
              distance: 160_000,
              icu_training_load: 250,
              icu_intensity: 82,
            },
            {
              id: 3,
              type: "Ride",
              start_date_local: "2023-03-15T08:00:00",
              moving_time: 1,
              elapsed_time: 1,
              distance: 80_000,
              icu_training_load: 120,
              icu_intensity: 74,
            },
            {
              id: 4,
              type: "Ride",
              start_date_local: "2023-09-10T08:00:00",
              moving_time: 1,
              elapsed_time: 1,
              distance: 120_000,
              icu_training_load: 210,
              icu_intensity: 81,
            },
          ],
        },
      };
      let clockNow = snapshot.captureClock.captureEpochMs;
      const summaries = snapshot.bundle.activities.map((activity, index) => ({
        id: String.fromCharCode(97 + index).repeat(64),
        workoutId: String.fromCharCode(101 + index).repeat(64),
        sessionSequence: 0,
        isMultisport: false,
        sport: "cycling",
        subSport: null,
        isTransition: false,
        startEpochSeconds: Math.floor(Date.parse(String(activity.start_date_local) + "Z") / 1_000),
        timezoneOffsetSeconds: 0,
        localDate: String(activity.start_date_local).slice(0, 10),
        elapsedSeconds: Number(activity.elapsed_time),
        timerSeconds: Number(activity.elapsed_time),
        movingSeconds: Number(activity.moving_time),
        distanceMeters: Number(activity.distance),
      }));
      const canonicalActivities: CanonicalActivityReader = {
        async listActivities(input) {
          return {
            activities: summaries.filter(
              (activity) => activity.localDate >= input.start && activity.localDate <= input.end,
            ),
            nextCursor: null,
          };
        },
        async getActivity() {
          return undefined;
        },
        async getStreams() {
          return undefined;
        },
      };
      const reader = createStoreAthleteDataReader({
        snapshot: () => snapshot,
        canonicalActivities,
        clockNow: () => clockNow,
      });
      const platformRead = vi.fn(() => {
        throw new Error("Platform reads disabled");
      });
      const client = { activities: { list: platformRead } } as unknown as IntervalsClient;
      const tools = createCoreToolsWithSportConfig(client, ["Ride"], reader);
      const rows = (
        await Promise.all([
          tools.intervals_fetch_activities!.execute!(
            { oldest: "2019-06-01", newest: "2019-06-01" },
            {} as never,
          ),
          tools.intervals_fetch_activities!.execute!(
            { oldest: "2022-07-02", newest: "2022-07-02" },
            {} as never,
          ),
          tools.intervals_fetch_activities!.execute!(
            { oldest: "2023-03-15", newest: "2023-09-10" },
            {} as never,
          ),
        ])
      ).flat() as Array<Record<string, unknown>>;
      expect(rows.find((row) => row.localDate === "2019-06-01")).toMatchObject({
        distanceMeters: 100_000,
      });
      expect(
        rows.reduce((greatest, row) =>
          Number(row.distanceMeters) > Number(greatest.distanceMeters) ? row : greatest,
        ),
      ).toMatchObject({ localDate: "2022-07-02", distanceMeters: 160_000 });
      expect(
        rows.filter((row) => ["2023-03-15", "2023-09-10"].includes(String(row.localDate))),
      ).toMatchObject([{ distanceMeters: 80_000 }, { distanceMeters: 120_000 }]);
      const initialProfile = await reader.getAthlete();
      expect(initialProfile.ok && formatStoreFreshness(initialProfile.freshness!)).toContain(
        "less than 60 seconds",
      );
      clockNow += 2 * 86_400_000;
      const agedProfile = await reader.getAthlete();
      expect(agedProfile.ok && formatStoreFreshness(agedProfile.freshness!)).toContain("2 days");
      await expect(
        tools.intervals_fetch_activities!.execute!(
          { oldest: "2023-03-15", newest: "2023-09-10" },
          {} as never,
        ),
      ).resolves.toEqual(rows.slice(2));
      expect(platformRead).not.toHaveBeenCalled();
      expect(await Promise.all(paths.map(digest))).toEqual(before);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
});
