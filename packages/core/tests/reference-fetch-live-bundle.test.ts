// `fetchLiveBundle` is the production sync's intervals.icu fetch + ADR-0012
// anti-corruption boundary. These tests inject a fake client (no network) and
// pin: TP-field rename on activities + wellness, activity snake-casing, the
// bounded/cycling-only/abort-aware stream loop, best-effort degradation, FTP
// history derivation from sportInfo, and the 7-day recent-activities slice.

import { describe, expect, it } from "vitest";

import {
  fetchLiveBundle,
  deriveFtpHistory,
  normalizeStreams,
  MAX_STREAM_ACTIVITIES,
  type BundleFetchClient,
} from "../src/reference/sync/fetch-live-bundle.js";
import type { WellnessDay } from "../src/reference/schemas/inputs.js";

const NOW = new Date("2026-06-09T12:00:00.000Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

/** camelCase activity row as the intervals.icu lib emits it (pre-snakeCase). */
function camelActivity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    startDateLocal: daysAgo(2),
    type: "Ride",
    movingTime: 3600,
    elapsedTime: 3700,
    icuTrainingLoad: 80,
    averageHeartrate: 140,
    icuCtl: 50, // TP source → fitnessAtEnd after rename
    icuAtl: 60, // TP source → fatigueAtEnd after rename
    ...over,
  };
}

function wellnessRaw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "2026-06-08",
    weight: 70,
    restingHR: 50,
    hrv: 60,
    sleepSecs: 28800,
    sleepQuality: 3,
    ctl: 40, // → fitness
    atl: 45, // → fatigue
    ctlLoad: 5,
    atlLoad: 6,
    rampRate: 1,
    sportInfo: [{ type: "Ride", eftp: 250 }],
    ...over,
  };
}

const STREAM_OK = { ok: true as const, value: { dfa_a1: [1, 0.8], heartrate: [140, 145], watts: [200, 210] } };

interface FakeOpts {
  activities?: Record<string, unknown>[];
  wellness?: Record<string, unknown>[];
  athlete?: unknown;
  streamFor?: (id: string) => { ok: true; value: unknown } | { ok: false; error: unknown };
  activitiesFail?: boolean;
}

function fakeClient(opts: FakeOpts): { client: BundleFetchClient; streamCalls: string[] } {
  const streamCalls: string[] = [];
  const client: BundleFetchClient = {
    athlete: { get: async () => ({ ok: true, value: opts.athlete ?? {} }) },
    activities: {
      list: async () =>
        opts.activitiesFail
          ? { ok: false, error: "boom" }
          : { ok: true, value: opts.activities ?? [] },
      getStreams: async (id: string) => {
        streamCalls.push(id);
        return opts.streamFor ? opts.streamFor(id) : STREAM_OK;
      },
    },
    wellness: { list: async () => ({ ok: true, value: opts.wellness ?? [] }) },
  };
  return { client, streamCalls };
}

describe("fetchLiveBundle", () => {
  it("snake-cases + renames TP fields on activities and wellness", async () => {
    const { client } = fakeClient({
      activities: [camelActivity({ id: 7 })],
      wellness: [wellnessRaw()],
    });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 });

    const act = res.bundle.activities[0]! as Record<string, unknown>;
    expect(act.start_date_local).toBeTypeOf("string");
    expect(act.fitnessAtEnd).toBe(50);
    expect(act.fatigueAtEnd).toBe(60);
    expect(act.icu_ctl).toBeUndefined();
    expect(act.icu_atl).toBeUndefined();

    const well = res.bundle.wellness[0]! as Record<string, unknown>;
    expect(well.fitness).toBe(40);
    expect(well.fatigue).toBe(45);
    expect(well.ctl).toBeUndefined();
    expect(well.atl).toBeUndefined();
  });

  it("fetches streams only for cycling rides within the stream window, capped", async () => {
    const cyclingInWindow = Array.from({ length: MAX_STREAM_ACTIVITIES + 3 }, (_, i) =>
      camelActivity({ id: 100 + i, startDateLocal: daysAgo(1 + i) }),
    );
    const activities = [
      ...cyclingInWindow,
      camelActivity({ id: 900, type: "Run", startDateLocal: daysAgo(1) }), // non-cycling
      camelActivity({ id: 901, startDateLocal: daysAgo(40) }), // outside stream window
    ];
    const { client, streamCalls } = fakeClient({ activities });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 });

    expect(streamCalls).toHaveLength(MAX_STREAM_ACTIVITIES);
    expect(streamCalls).not.toContain("900"); // run excluded
    expect(streamCalls).not.toContain("901"); // out-of-window excluded
    expect(Object.keys(res.bundle.streams ?? {})).toHaveLength(MAX_STREAM_ACTIVITIES);
    // full window still present in the metric-input activities (84-day fetch)
    expect(res.bundle.activities).toHaveLength(activities.length);
  });

  it("is best-effort: a failed stream fetch is skipped, others kept", async () => {
    const activities = [
      camelActivity({ id: 1, startDateLocal: daysAgo(1) }),
      camelActivity({ id: 2, startDateLocal: daysAgo(2) }),
    ];
    const { client } = fakeClient({
      activities,
      streamFor: (id) => (id === "1" ? { ok: false, error: "no streams" } : STREAM_OK),
    });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0, log: () => {} });
    expect(res.bundle.streams?.["1"]).toBeUndefined();
    expect(res.bundle.streams?.["2"]).toBeDefined();
  });

  it("breaks the stream loop when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const { client, streamCalls } = fakeClient({ activities: [camelActivity({ id: 1, startDateLocal: daysAgo(1) })] });
    const res = await fetchLiveBundle({ client, signal: ac.signal, now: NOW, throttleMs: 0 });
    expect(streamCalls).toHaveLength(0);
    expect(res.bundle.streams).toBeUndefined();
  });

  it("derives cycling FTP history from sportInfo.eftp (one point per change)", async () => {
    const { client } = fakeClient({
      wellness: [
        wellnessRaw({ id: "2026-05-01", sportInfo: [{ type: "Ride", eftp: 240 }] }),
        wellnessRaw({ id: "2026-05-08", sportInfo: [{ type: "Ride", eftp: 240 }] }), // no change
        wellnessRaw({ id: "2026-05-20", sportInfo: [{ type: "Ride", eftp: 250 }] }), // change
      ],
    });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 });
    expect(res.bundle.ftpHistory).toEqual([
      { date: "2026-05-01", ftp: 240, source: "estimate" },
      { date: "2026-05-20", ftp: 250, source: "estimate" },
    ]);
  });

  it("recentActivities is the 7-day slice; bundle keeps the full window", async () => {
    const { client } = fakeClient({
      activities: [
        camelActivity({ id: 1, startDateLocal: daysAgo(2) }), // within 7d
        camelActivity({ id: 2, startDateLocal: daysAgo(30) }), // outside 7d, inside 84d
      ],
    });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 });
    expect(res.recentActivities).toHaveLength(1);
    expect(res.bundle.activities).toHaveLength(2);
  });

  it("extracts athlete sportSettings when present", async () => {
    const { client } = fakeClient({
      athlete: { sportSettings: [{ types: ["Ride"], ftp: 250, indoor_ftp: 240, lthr: 165 }] },
    });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 });
    expect(res.bundle.athlete?.sportSettings[0]?.ftp).toBe(250);
  });

  it("throws when the activities list is unreachable", async () => {
    const { client } = fakeClient({ activitiesFail: true });
    await expect(
      fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 }),
    ).rejects.toThrow(/activities\.list failed/);
  });
});

describe("fetchLiveBundle — real lib stream shapes + edge cases", () => {
  it("normalizes the lib's ARRAY stream shape so dfa_a1 lands", async () => {
    // The real getStreams returns camelCased `[{type, data}, …]`, not a
    // channel-keyed object — the bug the review caught (DFA never computed).
    const { client } = fakeClient({
      activities: [camelActivity({ id: 1, startDateLocal: daysAgo(1) })],
      streamFor: () => ({
        ok: true,
        value: [
          { type: "dfa_a1", data: [1, 0.8] },
          { type: "watts", data: [200, 210] },
          { type: "heartrate", data: [140, 145] },
          { type: "time", data: [0, 1] },
        ],
      }),
    });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 });
    expect(res.bundle.streams?.["1"]?.dfa_a1).toEqual([1, 0.8]);
    expect(res.bundle.streams?.["1"]?.watts).toEqual([200, 210]);
  });

  it("normalizes the lib's camelCased OBJECT stream shape (dfaA1 -> dfa_a1)", async () => {
    const { client } = fakeClient({
      activities: [camelActivity({ id: 1, startDateLocal: daysAgo(1) })],
      streamFor: () => ({ ok: true, value: { dfaA1: [1, 0.8], watts: [200], heartrate: [140] } }),
    });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 });
    expect(res.bundle.streams?.["1"]?.dfa_a1).toEqual([1, 0.8]);
  });

  it("drops a wrong-shaped stream body (not array-of-channels, not object)", async () => {
    const { client } = fakeClient({
      activities: [camelActivity({ id: 1, startDateLocal: daysAgo(1) })],
      streamFor: () => ({ ok: true, value: "garbage" }),
    });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0, log: () => {} });
    expect(res.bundle.streams).toBeUndefined();
  });

  it("recovers indoor_ftp from the lib's camelCased athlete profile", async () => {
    const { client } = fakeClient({
      athlete: { sportSettings: [{ types: ["Ride"], ftp: 250, indoorFtp: 240, lthr: 165 }] },
    });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 });
    expect(res.bundle.athlete?.sportSettings[0]?.indoor_ftp).toBe(240);
  });

  it("resolves with a warning when athlete.get fails (no settings, not a crash)", async () => {
    const logs: string[] = [];
    const client: BundleFetchClient = {
      athlete: { get: async () => ({ ok: false, error: "unauthorized" }) },
      activities: { list: async () => ({ ok: true, value: [] }), getStreams: async () => STREAM_OK },
      wellness: { list: async () => ({ ok: true, value: [] }) },
    };
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0, log: (m) => logs.push(m) });
    expect(res.bundle.athlete).toBeUndefined();
    expect(logs.some((l) => l.includes("athlete.get failed"))).toBe(true);
  });

  it("resolves with empty wellness + a warning when wellness.list fails", async () => {
    const logs: string[] = [];
    const client: BundleFetchClient = {
      athlete: { get: async () => ({ ok: true, value: {} }) },
      activities: { list: async () => ({ ok: true, value: [] }), getStreams: async () => STREAM_OK },
      wellness: { list: async () => ({ ok: false, error: "timeout" }) },
    };
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0, log: (m) => logs.push(m) });
    expect(res.bundle.wellness).toEqual([]);
    expect(res.bundle.ftpHistory).toEqual([]);
    expect(logs.some((l) => l.includes("wellness.list failed"))).toBe(true);
  });

  it("treats a non-array activities body as empty (ok:true, malformed) without crashing", async () => {
    const logs: string[] = [];
    const client: BundleFetchClient = {
      athlete: { get: async () => ({ ok: true, value: {} }) },
      activities: { list: async () => ({ ok: true, value: { not: "an array" } as unknown as unknown[] }), getStreams: async () => STREAM_OK },
      wellness: { list: async () => ({ ok: true, value: [] }) },
    };
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0, log: (m) => logs.push(m) });
    expect(res.bundle.activities).toEqual([]);
    expect(logs.some((l) => l.includes("non-array"))).toBe(true);
  });

  it("breaks the stream loop mid-flight when aborted during a fetch", async () => {
    const ac = new AbortController();
    const activities = [
      camelActivity({ id: 1, startDateLocal: daysAgo(1) }),
      camelActivity({ id: 2, startDateLocal: daysAgo(2) }),
      camelActivity({ id: 3, startDateLocal: daysAgo(3) }),
    ];
    const { client, streamCalls } = fakeClient({
      activities,
      streamFor: () => {
        ac.abort();
        return STREAM_OK;
      },
    });
    await fetchLiveBundle({ client, signal: ac.signal, now: NOW, throttleMs: 0 });
    expect(streamCalls).toHaveLength(1);
  });

  it("anchors frozenNow to naive local time (no UTC Z/offset suffix)", async () => {
    const { client } = fakeClient({ activities: [] });
    const res = await fetchLiveBundle({ client, signal: new AbortController().signal, now: NOW, throttleMs: 0 });
    expect(res.frozenNow).not.toMatch(/[Z+]/);
    expect(res.frozenNow).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  });
});

describe("normalizeStreams", () => {
  it("maps an array of {type,data} channels to a channel-keyed object", () => {
    expect(
      normalizeStreams([
        { type: "dfa_a1", data: [1, 0.8] },
        { type: "watts", data: [200] },
      ]),
    ).toEqual({ dfa_a1: [1, 0.8], watts: [200] });
  });
  it("snake-cases a camelCased object body", () => {
    expect(normalizeStreams({ dfaA1: [1], heartrate: [140] })).toEqual({ dfa_a1: [1], heartrate: [140] });
  });
  it("passes a scalar through untouched", () => {
    expect(normalizeStreams("garbage")).toBe("garbage");
  });
});

describe("deriveFtpHistory", () => {
  it("ignores non-cycling sportInfo and rounds eftp", () => {
    const wellness: WellnessDay[] = [
      { id: "2026-05-01", weight: null, restingHR: null, hrv: null, sleepSecs: null, sleepQuality: null, sportInfo: [{ type: "Run", eftp: 300 }] } as WellnessDay,
      { id: "2026-05-02", weight: null, restingHR: null, hrv: null, sleepSecs: null, sleepQuality: null, sportInfo: [{ type: "Ride", eftp: 249.6 }] } as WellnessDay,
    ];
    expect(deriveFtpHistory(wellness)).toEqual([{ date: "2026-05-02", ftp: 250, source: "estimate" }]);
  });
});
