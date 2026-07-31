import { createHash } from "node:crypto";
import { canonicalJson } from "@enduragent/kernel/archive";
import type { SyncBudget } from "@enduragent/kernel/store";
import { describe, expect, it } from "vitest";
import { createIntervalsIcuSource } from "../src/source.js";

const NOW = new Date("1998-07-18T12:00:00.000Z");
const PROFILE = { sportSettings: [{ id: 7, athlete_id: "synthetic-athlete", types: ["Ride"], updated: "1998-07-01T00:00:00.000Z", ftp: 250 }] };
const ACTIVITY = { id: 42, type: "Ride", start_date: "1998-07-17T10:00:00.000Z",
  start_date_local: "1998-07-17T12:00:00", moving_time: 3600, elapsed_time: 3700, distance: 40_000 };
const WELLNESS = { id: "1998-07-17", restingHR: 50 };

function response(value: unknown, status = 200, contentType = "application/json") {
  return { status, headers: { "content-type": contentType }, body: new TextEncoder().encode(JSON.stringify(value)) };
}

function budget(maxArtifacts = 20): SyncBudget {
  return { signal: new AbortController().signal, clock: { monotonicNow: () => 1 }, deadlineMonotonicMs: 1_000,
    perRequestTimeoutMs: 1_000, maxRequests: 20, maxArtifacts };
}

function fixture(stream: unknown = { time: [0, 1], watts: [200, 210] }) {
  const requests: string[] = [], writes: { payload: unknown; epoch: number }[] = [];
  const queue = [response(PROFILE), response([ACTIVITY]), response([WELLNESS]), response(stream)];
  const source = createIntervalsIcuSource({ athleteId: "synthetic-athlete", historyNewestDate: "1998-07-18",
    minRequestIntervalMs: 250, wallClock: { now: () => NOW.getTime() }, sleep: async () => {},
    httpFactory: () => ({ fetch: async (request) => { requests.push(request.url); return queue.shift()!; } }),
    archive: {
      async writeSnapshot(payload, instant) { writes.push({ payload, epoch: instant.epochSeconds });
        const address = createHash("sha256").update(canonicalJson(payload)).update(String(instant.epochSeconds)).digest("hex");
        return { address, relPath: `1998/07/${address}.json.gz`, deduped: false }; },
      async writeArtifact() { throw new Error("unused"); }, async quarantine() { throw new Error("unused"); },
      async readArtifact() { throw new Error("unused"); }, async readSnapshot() { throw new Error("unused"); }, async has() { return false; },
    },
    acl: { activity: (row) => row, wellness: (row) => row,
      streams(value) { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("bad stream"); return value as Record<string, unknown>; },
      assertClean() {} },
  });
  return { source, requests, writes };
}

describe("captureReference", () => {
  it("fetches exact endpoints in selector order and archives whole/member evidence after fetch", async () => {
    const value = fixture(), batch = await value.source.captureReference(NOW, budget());
    expect(value.requests).toHaveLength(4);
    expect(value.requests[0]).toMatch(/\/api\/v1\/athlete\/synthetic-athlete$/);
    expect(value.requests[1]).toContain("/activities?oldest=");
    expect(value.requests[2]).toContain("/wellness?oldest=");
    expect(value.requests[3]).toContain("/api/v1/activity/42/streams.json?types=time&types=watts&types=heartrate&types=dfa_a1&types=artifacts&includeDefaults=false");
    expect(batch.selected_stream_ids).toEqual(["42"]);
    expect(batch.captured_stream_ids).toEqual(["42"]);
    expect(batch.records.settings[0]?.externalId).toMatch(/^settings:/);
    expect(batch.records.activities[0]?.externalId).toBe("42");
    expect(batch.records.wellness[0]?.externalId).toBe("1998-07-17");
    expect(batch.records.streams[0]?.externalId).toBe("streams:42");
    expect(batch.records.streams[0]?.archive).toBe(batch.endpoints[3]?.archive);
    expect(value.writes).toHaveLength(7);
  });

  it("omits malformed stream responses without omitting required lanes", async () => {
    const value = fixture("invalid"), batch = await value.source.captureReference(NOW, budget());
    expect(batch.selected_stream_ids).toEqual(["42"]);
    expect(batch.captured_stream_ids).toEqual([]);
    expect(batch.endpoints).toHaveLength(3);
    expect(batch.records.activities).toHaveLength(1);
  });

  it("reserves every selected stream artifact before requests or archives", async () => {
    const value = fixture();
    await expect(value.source.captureReference(NOW, budget(6))).rejects.toThrow();
    expect(value.requests).toHaveLength(3);
    expect(value.writes).toHaveLength(0);
  });

  it("derives live membership in whole-payload encounter order and omits malformed members", async () => {
    const value = fixture(), plan = (await value.source.captureReference(NOW, budget())).plan;
    const derived = await value.source.deriveReferenceCaptureMembers(plan, [
      { ordinal: 0, lane: "settings", endpoint: "athlete-profile", request: { oldest: null, newest: null, activity_id: null, stream_types: [], include_defaults: null }, payload: PROFILE },
      { ordinal: 1, lane: "activities", endpoint: "activities", request: { oldest: plan.window.oldest, newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null }, payload: [{ bad: true }, ACTIVITY] },
      { ordinal: 2, lane: "wellness", endpoint: "wellness", request: { oldest: plan.window.oldest, newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null }, payload: [{ id: "bad" }, WELLNESS] },
    ]);
    expect(derived.activities[0]?.payload_index).toBe(1);
    expect(derived.wellness[0]?.payload_index).toBe(1);
  });
});
