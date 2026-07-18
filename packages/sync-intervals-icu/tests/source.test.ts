import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalJson, type ArchiveManager } from "@enduragent/kernel/archive";
import type { HttpPort, HttpResponse } from "@enduragent/kernel/ports";
import {
  createPhysicalRequestLedger,
  type PhysicalRequestLedger,
  type SourceWatermark,
  type SyncBudget,
} from "@enduragent/kernel/store";
import { compactCursor, createIntervalsIcuSource, INTERVALS_ICU_CAPABILITIES } from "../src/index.js";

const json = (value: unknown): HttpResponse => ({ status: 200, headers: { "content-type": "application/json; charset=utf-8" },
  body: new TextEncoder().encode(JSON.stringify(value)) });
const activity = (id: string, date = "1998-01-05") => ({ id, start_date: `${date}T07:00:00Z`, start_date_local: `${date}T08:00:00`,
  type: "Ride", moving_time: 90, elapsed_time: 100, distance: 1_000 });

function archive(log: string[] = []): ArchiveManager {
  const values = new Map<string, unknown>();
  return {
    async writeSnapshot(value, when) { log.push(`archive:${Array.isArray(value) ? "page" : "row"}`);
      const address = createHash("sha256").update(canonicalJson(value)).digest("hex"), relPath = `${when.epochSeconds}/${address}.json.gz`;
      const deduped = values.has(relPath); values.set(relPath, structuredClone(value)); return { address, relPath, deduped }; },
    async writeArtifact(bytes, ext, when) { const address = createHash("sha256").update(bytes).digest("hex");
      return { address, relPath: `${when.epochSeconds}/${address}.${ext}`, deduped: false }; },
    async readSnapshot(path) { return structuredClone(values.get(path)); }, async has(path) { return values.has(path); },
    async readArtifact() { throw new Error("unused"); }, async quarantine() { throw new Error("unused"); },
  };
}

function budget(maxArtifacts = 100, maxRequests = 100): SyncBudget {
  return { signal: new AbortController().signal, clock: { monotonicNow: () => 0 }, deadlineMonotonicMs: 1_000_000,
    perRequestTimeoutMs: 30_000, maxRequests, maxArtifacts };
}

function source(http: HttpPort, options: { oldest?: string; newest?: string; archive?: ArchiveManager;
  log?: string[]; attemptLedger?: PhysicalRequestLedger } = {}) {
  const log = options.log ?? [];
  return createIntervalsIcuSource({ athleteId: "synthetic-athlete", historyOldestDate: options.oldest ?? "1998-01-01",
    historyNewestDate: options.newest ?? "1998-12-31", minRequestIntervalMs: 250,
    httpFactory: () => http, archive: options.archive ?? archive(log), wallClock: { now: () => Date.UTC(1998, 0, 1) },
    sleep: async () => {}, acl: {
      activity(row) { log.push("acl:activity"); return row; }, wellness(row) { log.push("acl:wellness"); return row; },
      streams(value) { log.push("acl:streams"); return Array.isArray(value)
        ? Object.fromEntries(value.map((entry) => [(entry as { type: string }).type, (entry as { data: unknown }).data])) : value as Record<string, unknown>; },
      assertClean() {},
    }, ...(options.attemptLedger === undefined ? {} : { attemptLedger: options.attemptLedger }) });
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const result: unknown[] = []; for await (const value of iterable) result.push(value); return result;
}
const watermark = (lane: SourceWatermark["lane"], value: string | null = null): SourceWatermark => ({ source: "intervals-icu", lane, value });

describe("intervals.icu full-history source", () => {
  it("exposes exact capabilities", () => {
    const value = source({ fetch: async () => json([]) });
    expect(value.id).toBe("intervals-icu"); expect(value.capabilities).toEqual(INTERVALS_ICU_CAPABILITIES);
  });

  it("uses inclusive 365-date windows with no limit parameter", async () => {
    const requests: string[] = [];
    const value = source({ fetch: async (request) => { requests.push(request.url); return json([]); } },
      { oldest: "1998-01-01", newest: "1999-12-31" });
    const result = await collect(value.pull(watermark("activities"), budget()));
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]!);
    expect([...url.searchParams]).toEqual([["oldest", "1998-01-01"], ["newest", "1998-12-31"]]);
    expect(url.searchParams.has("limit")).toBe(false);
    const cursor = JSON.parse((result.at(-1) as { watermark: { value: string } }).watermark.value);
    expect(cursor).toMatchObject({ window_start: "1999-01-01", window_end: "1999-12-31", complete: false });
  });

  it("supports mid-page resume and terminal refresh cycle", async () => {
    const http: HttpPort = { fetch: async () => json([activity("a"), activity("b", "1998-01-06")]) };
    const value = source(http);
    const first = await collect(value.pull(watermark("activities"), budget(1)));
    expect((first[0] as { externalId: string }).externalId).toBe("a");
    const firstCursor = (first[1] as { watermark: { value: string } }).watermark.value;
    const resumed = await collect(value.pull(watermark("activities", firstCursor), budget(1)));
    expect((resumed[0] as { externalId: string }).externalId).toBe("b");
    const terminal = compactCursor({ v: 1, cycle: 3, window_start: "1998-01-01", window_end: "1998-12-31", last_key: null, complete: true });
    const refreshed = await collect(value.pull(watermark("activities", terminal), budget(1)));
    expect(JSON.parse((refreshed.at(-1) as { watermark: { value: string } }).watermark.value).cycle).toBe(4);
  });

  it("archives page and row before ACL and transport remains unchanged", async () => {
    const log: string[] = [], raw = activity("archive-order");
    const value = source({ fetch: async () => json([raw]) }, { log, archive: archive(log) });
    const iterator = value.pull(watermark("activities"), budget())[Symbol.asyncIterator]();
    const first = await iterator.next(); log.push("yield");
    expect(log).toEqual(["archive:page", "archive:row", "acl:activity", "yield"]);
    expect((first.value as { payload: unknown }).payload).toEqual(raw);
    expect((first.value as { landing: { platform: { activity: unknown } } }).landing.platform.activity).not.toBe(raw);
    await iterator.next();
  });

  it("attempts all activity streams with no live-bundle cap", async () => {
    const activities = Array.from({ length: 13 }, (_, index) => activity(`s${String(index).padStart(2, "0")}`, `1998-01-${String(index + 1).padStart(2, "0")}`));
    const requests: string[] = [];
    const http: HttpPort = { fetch: async (request) => {
      requests.push(request.url);
      return request.url.includes("/activities?") ? json(activities) : json([{ type: "time", data: [0] }, { type: "watts", data: [100] }]);
    } };
    const result = await collect(source(http).pull(watermark("streams"), budget(20, 20)));
    expect(result.filter((entry) => (entry as { kind: string }).kind === "snapshot")).toHaveLength(13);
    expect(requests.filter((url) => url.includes("streams.json"))).toHaveLength(13);
    const streamUrl = new URL(requests.find((url) => url.includes("streams.json"))!);
    expect(streamUrl.searchParams.getAll("types")).toEqual(["time", "watts", "heartrate", "dfa_a1", "artifacts"]);
    expect(streamUrl.searchParams.get("includeDefaults")).toBe("false");
  });

  it("checkpoints before another request or artifact would exceed the cap", async () => {
    const fetch = vi.fn(async () => json([activity("one"), activity("two", "1998-01-06")]));
    const result = await collect(source({ fetch }).pull(watermark("activities"), budget(1, 1)));
    expect(result.map((entry) => (entry as { kind: string }).kind)).toEqual(["snapshot", "checkpoint"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("charges the injected physical-attempt ledger at the actual source request", async () => {
    const attemptLedger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
    await collect(source({ fetch: async () => json([]) }, { attemptLedger })
      .pull(watermark("activities"), budget()));
    expect(attemptLedger.snapshot()).toMatchObject({
      storeRequests: 1,
      legacyRequests: 0,
      totalRequests: 1,
      byTag: { "store:activities": 1 },
    });
  });
});
