import { describe, expect, it } from "vitest";
import type { ArchiveManager } from "@enduragent/kernel/archive";
import type { HttpResponse } from "@enduragent/kernel/ports";
import {
  analyticsCurveWindows,
  createPhysicalRequestLedger,
  type AnalyticsCurveGeneration,
  type AnalyticsCurveRepository,
  type SyncBudget,
} from "@enduragent/kernel/store";
import {
  ANALYTICS_CURVE_MAX_RESPONSE_BYTES,
  refreshAnalyticsCurves,
  type RefreshAnalyticsCurvesOptions,
} from "../src/index.js";

const FROZEN_MS = Date.parse("2012-06-15T12:00:00.000Z");
const FROZEN_EPOCH_SECONDS = FROZEN_MS / 1_000;
const GENERATION_ID = "a".repeat(64);

function jsonResponse(value: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function generation(): AnalyticsCurveGeneration {
  return Object.freeze({
    generationId: GENERATION_ID,
    frozenEpochSeconds: FROZEN_EPOCH_SECONDS,
    frozenOn: "2012-06-15",
    windows: analyticsCurveWindows("2012-06-15"),
  });
}

function harness(responses: readonly (HttpResponse | Error)[] = [
  jsonResponse({ activities: {}, list: [] }),
  jsonResponse({ activities: {}, list: [] }),
  jsonResponse({ activities: {}, list: [] }),
  jsonResponse({ activities: {}, list: [] }),
]) {
  let monotonicMs = 1_000;
  let responseIndex = 0;
  let active = 0;
  let maxActive = 0;
  let archiveIndex = 0;
  const events: string[] = [];
  const requests: string[] = [];
  const evidence: Parameters<AnalyticsCurveRepository["recordEvidence"]>[0][] = [];
  const failures: Parameters<AnalyticsCurveRepository["recordRefreshFailure"]>[0][] = [];
  const promotions: Parameters<AnalyticsCurveRepository["promoteGeneration"]>[0][] = [];
  const ledger = createPhysicalRequestLedger({ storeLimit: 64, legacyLimit: 15, totalLimit: 79 });
  const repository: AnalyticsCurveRepository = Object.freeze({
    async beginGeneration() {
      events.push("begin");
      return { generation: generation(), inserted: true };
    },
    async recordEvidence(input: Parameters<AnalyticsCurveRepository["recordEvidence"]>[0]) {
      evidence.push(input);
      events.push(`evidence:${input.curveFamily}:${input.activityType}`);
      return {
        inserted: true,
        evidence: {
          evidenceId: "b".repeat(64),
          requestIdentity: "c".repeat(64),
          ...input,
        },
      };
    },
    async promoteGeneration(input: Parameters<AnalyticsCurveRepository["promoteGeneration"]>[0]) {
      promotions.push(input);
      events.push("promote");
      return "promoted" as const;
    },
    async recordRefreshFailure(
      input: Parameters<AnalyticsCurveRepository["recordRefreshFailure"]>[0],
    ) {
      failures.push(input);
      events.push(`failure:${input.code}`);
    },
    async readState() {
      return { current: null, refreshFailure: null };
    },
  });
  const archive = Object.freeze({
    async writeSnapshot() {
      const current = archiveIndex++;
      const address = (current + 1).toString(16).padStart(64, "0");
      events.push(`archive:${current}`);
      return { address, relPath: `2012/06/${address}.json.gz`, deduped: false };
    },
  }) as unknown as ArchiveManager;
  const controller = new AbortController();
  const budget: SyncBudget = {
    signal: controller.signal,
    clock: { monotonicNow: () => monotonicMs },
    deadlineMonotonicMs: 601_000,
    perRequestTimeoutMs: 30_000,
    maxRequests: 64,
    maxArtifacts: 1_000,
  };
  const options: RefreshAnalyticsCurvesOptions = {
    athleteId: "i0",
    frozenOn: "2012-06-15",
    minRequestIntervalMs: 250,
    archive,
    repository,
    attemptLedger: ledger,
    wallClock: { now: () => FROZEN_MS },
    sleep: async (ms, signal) => {
      signal.throwIfAborted();
      monotonicMs += ms;
    },
    budget,
    httpFactory: ({ outer, perRequestTimeoutMs }) => {
      expect(outer).toBeInstanceOf(AbortSignal);
      expect(perRequestTimeoutMs).toBe(30_000);
      return {
        async fetch(request) {
          requests.push(request.url);
          active += 1;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active -= 1;
          const selected = responses[responseIndex++];
          if (selected instanceof Error) throw selected;
          if (selected === undefined) throw new Error("unexpected request");
          return selected;
        },
      };
    },
  };
  return { options, budget, controller, ledger, repository, requests, events, evidence, failures,
    promotions, maxActive: () => maxActive };
}

describe("analytics curve acquisition", () => {
  it("reserves four calls, serializes exact selectors, archives first, and promotes once", async () => {
    const test = harness();
    const result = await refreshAnalyticsCurves(test.options);

    expect(result).toMatchObject({
      kind: "promoted",
      generationId: GENERATION_ID,
      frozenAt: "2012-06-15T12:00:00.000Z",
      physicalRequests: 4,
    });
    expect(test.maxActive()).toBe(1);
    expect(test.ledger.snapshot()).toMatchObject({
      storeRequests: 4,
      totalRequests: 4,
      byTag: { "store:analytics-curves": 4 },
    });
    expect(test.requests.map((value) => new URL(value).pathname)).toEqual([
      "/api/v1/athlete/i0/power-curves",
      "/api/v1/athlete/i0/power-curves",
      "/api/v1/athlete/i0/hr-curves",
      "/api/v1/athlete/i0/hr-curves",
    ]);
    const parsed = test.requests.map((value) => new URL(value));
    expect(parsed.map((url) => url.searchParams.get("curves"))).toEqual(Array(4).fill(
      "r.2012-05-19.2012-06-15,r.2012-04-21.2012-05-18,r.2012-05-05.2012-06-15",
    ));
    expect(parsed.map((url) => url.searchParams.get("type"))).toEqual(Array(4).fill("Ride"));
    expect(parsed.map((url) => JSON.parse(url.searchParams.get("filters")!))).toEqual([
      [{ field_id: "type", value: ["Ride"] }],
      [{ field_id: "type", value: ["VirtualRide"] }],
      [{ field_id: "type", value: ["Ride"] }],
      [{ field_id: "type", value: ["VirtualRide"] }],
    ]);
    expect(test.events).toEqual([
      "begin",
      "archive:0", "evidence:power:Ride",
      "archive:1", "evidence:power:VirtualRide",
      "archive:2", "evidence:heart-rate:Ride",
      "archive:3", "evidence:heart-rate:VirtualRide",
      "promote",
    ]);
    expect(test.evidence).toHaveLength(4);
    expect(test.promotions).toEqual([{
      generationId: GENERATION_ID,
      promotedEpochSeconds: FROZEN_EPOCH_SECONDS,
    }]);
    expect(test.failures).toEqual([]);
  });

  it("uses the capture civil date for selectors when it is adjacent to the UTC date", async () => {
    const test = harness();
    const result = await refreshAnalyticsCurves({ ...test.options, frozenOn: "2012-06-16" });

    expect(result).toMatchObject({ kind: "promoted", frozenAt: "2012-06-15T12:00:00.000Z" });
    expect(test.requests.map((value) => new URL(value).searchParams.get("curves"))).toEqual(
      Array(4).fill(
        "r.2012-05-20.2012-06-16,r.2012-04-22.2012-05-19,r.2012-05-06.2012-06-16",
      ),
    );
  });

  it("makes zero calls when all four physical slots cannot be reserved", async () => {
    const test = harness();
    for (let index = 0; index < 61; index += 1) {
      test.ledger.charge("store", "store:activities");
    }
    const result = await refreshAnalyticsCurves(test.options);

    expect(result).toMatchObject({
      kind: "skipped",
      physicalRequests: 0,
      failure: "request-budget-exhausted",
    });
    expect(test.requests).toEqual([]);
    expect(test.evidence).toEqual([]);
    expect(test.promotions).toEqual([]);
    expect(test.failures).toEqual([{
      generationId: GENERATION_ID,
      code: "request-budget-exhausted",
      failedEpochSeconds: FROZEN_EPOCH_SECONDS,
    }]);
  });

  it("does not retry a failed part and releases every unused reserved slot", async () => {
    const test = harness([
      jsonResponse({ activities: {}, list: [] }),
      jsonResponse({ message: "limited" }, 429),
    ]);
    const result = await refreshAnalyticsCurves(test.options);

    expect(result).toMatchObject({ kind: "failed", physicalRequests: 2, failure: "rate-limited" });
    expect(test.requests).toHaveLength(2);
    expect(test.evidence).toHaveLength(1);
    expect(test.promotions).toEqual([]);
    expect(test.failures[0]?.code).toBe("rate-limited");
    const remaining = test.ledger.tryReserve("store", "store:analytics-curves", 62);
    expect(remaining).not.toBeNull();
    remaining?.release();
  });

  it("archives valid JSON before rejecting a malformed curve envelope", async () => {
    const test = harness([jsonResponse({ activities: {} })]);
    const result = await refreshAnalyticsCurves(test.options);

    expect(result).toMatchObject({
      kind: "failed",
      physicalRequests: 1,
      failure: "malformed-response",
    });
    expect(test.events).toEqual(["begin", "archive:0", "failure:malformed-response"]);
    expect(test.evidence).toEqual([]);
    expect(test.promotions).toEqual([]);
  });

  it("rejects an oversized decoded response before archive or persistence", async () => {
    const test = harness([{
      status: 200,
      headers: { "content-type": "application/json" },
      body: new Uint8Array(ANALYTICS_CURVE_MAX_RESPONSE_BYTES + 1),
    }]);
    const result = await refreshAnalyticsCurves(test.options);

    expect(result).toMatchObject({
      kind: "failed",
      physicalRequests: 1,
      failure: "response-too-large",
    });
    expect(test.events).toEqual(["begin", "failure:response-too-large"]);
  });

  it("aborts before the first call without publishing a partial generation", async () => {
    const test = harness();
    test.controller.abort(new Error("shutdown"));
    const result = await refreshAnalyticsCurves(test.options);

    expect(result).toMatchObject({ kind: "failed", physicalRequests: 0, failure: "cancelled" });
    expect(test.requests).toEqual([]);
    expect(test.evidence).toEqual([]);
    expect(test.promotions).toEqual([]);
  });

  it("classifies a transport error without replaying the request", async () => {
    const test = harness([new Error("offline")]);
    const result = await refreshAnalyticsCurves(test.options);

    expect(result).toMatchObject({ kind: "failed", physicalRequests: 1, failure: "network" });
    expect(test.requests).toHaveLength(1);
    expect(test.promotions).toEqual([]);
  });

  it("stops before the next request when the lane deadline has no pacing headroom", async () => {
    const test = harness();
    const options = {
      ...test.options,
      budget: { ...test.budget, deadlineMonotonicMs: 1_100 },
    };
    const result = await refreshAnalyticsCurves(options);

    expect(result).toMatchObject({ kind: "failed", physicalRequests: 1, failure: "timeout" });
    expect(test.requests).toHaveLength(1);
    expect(test.promotions).toEqual([]);
  });

  it("does not misclassify a local archive failure as a network failure", async () => {
    const test = harness();
    const options = {
      ...test.options,
      archive: Object.freeze({
        async writeSnapshot() {
          throw new Error("disk unavailable");
        },
      }) as unknown as ArchiveManager,
    };
    const result = await refreshAnalyticsCurves(options);

    expect(result).toMatchObject({
      kind: "failed",
      physicalRequests: 1,
      failure: "temporary-failure",
    });
    expect(test.requests).toHaveLength(1);
    expect(test.evidence).toEqual([]);
    expect(test.promotions).toEqual([]);
  });
});
