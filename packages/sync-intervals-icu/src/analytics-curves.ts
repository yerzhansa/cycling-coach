import {
  AthleteHeartRateCurveSetSchema,
  AthletePowerCurveSetSchema,
  decode,
} from "intervals-icu-api";
import type { ArchiveManager } from "@enduragent/kernel/archive";
import type { ClockPort, HttpResponse } from "@enduragent/kernel/ports";
import {
  ANALYTICS_CURVE_PARTS,
  analyticsCurveWindows,
  type AnalyticsCurveRefreshFailureCode,
  type AnalyticsCurveRepository,
  type PhysicalRequestLedger,
  type PhysicalRequestReservation,
  type SyncBudget,
} from "@enduragent/kernel/store";
import { MIN_CONFIGURED_INTERVAL_MS, validateBudget } from "./http.js";
import type { IntervalsHttpFactory } from "./types.js";

export const ANALYTICS_CURVE_REQUESTS = 4;
export const ANALYTICS_CURVE_REQUEST_TIMEOUT_MS = 30_000;
export const ANALYTICS_CURVE_LANE_TIMEOUT_MS = 120_000;
export const ANALYTICS_CURVE_MAX_RESPONSE_BYTES = 2_097_152;
export const ANALYTICS_CURVE_MAX_TOTAL_BYTES = 8_388_608;

export type AnalyticsCurveRefreshOutcome =
  | {
      readonly kind: "promoted";
      readonly generationId: string;
      readonly frozenAt: string;
      readonly physicalRequests: 4;
      readonly decodedBytes: number;
    }
  | {
      readonly kind: "failed" | "skipped";
      readonly generationId: string;
      readonly frozenAt: string;
      readonly physicalRequests: number;
      readonly decodedBytes: number;
      readonly failure: AnalyticsCurveRefreshFailureCode;
    };

export interface RefreshAnalyticsCurvesOptions {
  readonly athleteId: string;
  readonly minRequestIntervalMs: number;
  readonly httpFactory: IntervalsHttpFactory;
  readonly archive: ArchiveManager;
  readonly repository: AnalyticsCurveRepository;
  readonly attemptLedger: PhysicalRequestLedger;
  readonly wallClock: Pick<ClockPort, "now">;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly budget: SyncBudget;
}

class AnalyticsCurveRequestError extends Error {
  constructor(readonly code: AnalyticsCurveRefreshFailureCode) {
    super("analytics curve refresh failed");
    this.name = "AnalyticsCurveRequestError";
  }
}

function nonempty(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("athlete id is invalid");
  return value;
}

function monotonicNow(budget: SyncBudget): number {
  const value = budget.clock.monotonicNow();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError("sync clock is invalid");
  }
  return value;
}

function wallEpochSeconds(clock: Pick<ClockPort, "now">): number {
  const value = clock.now();
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new TypeError("wall clock is invalid");
  }
  return Math.floor(value / 1_000);
}

function baseContentType(response: HttpResponse): string {
  return (response.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function responseFailure(status: number): AnalyticsCurveRefreshFailureCode {
  if (status === 429) return "rate-limited";
  if (status === 408 || status === 504) return "timeout";
  if (status === 404 || status >= 500) return "provider-unavailable";
  return "temporary-failure";
}

function parseResponse(response: HttpResponse): unknown {
  if (response.status !== 200) throw new AnalyticsCurveRequestError(responseFailure(response.status));
  if (baseContentType(response) !== "application/json") {
    throw new AnalyticsCurveRequestError("malformed-response");
  }
  if (response.body.byteLength > ANALYTICS_CURVE_MAX_RESPONSE_BYTES) {
    throw new AnalyticsCurveRequestError("response-too-large");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
  } catch {
    throw new AnalyticsCurveRequestError("malformed-response");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AnalyticsCurveRequestError("malformed-response");
  }
}

function isValidCurvePayload(curveFamily: "power" | "heart-rate", value: unknown): boolean {
  return curveFamily === "power"
    ? decode(AthletePowerCurveSetSchema, value).ok
    : decode(AthleteHeartRateCurveSetSchema, value).ok;
}

function requestUrl(
  athleteId: string,
  curveFamily: "power" | "heart-rate",
  activityType: "Ride" | "VirtualRide",
  selectors: readonly string[],
): string {
  const url = new URL(
    `/api/v1/athlete/${encodeURIComponent(athleteId)}/${curveFamily === "power" ? "power" : "hr"}-curves`,
    "https://intervals.icu",
  );
  url.searchParams.set("curves", selectors.join(","));
  url.searchParams.set("type", "Ride");
  url.searchParams.set("filters", JSON.stringify([{ field_id: "type", value: [activityType] }]));
  return url.toString();
}

function safeFailure(
  error: unknown,
  budgetSignal: AbortSignal,
  laneSignal: AbortSignal,
): AnalyticsCurveRefreshFailureCode {
  if (error instanceof AnalyticsCurveRequestError) return error.code;
  if (budgetSignal.aborted) return "cancelled";
  if (laneSignal.aborted) return "timeout";
  return "temporary-failure";
}

async function recordFailure(
  repository: AnalyticsCurveRepository,
  generationId: string,
  frozenEpochSeconds: number,
  wallClock: Pick<ClockPort, "now">,
  code: AnalyticsCurveRefreshFailureCode,
): Promise<void> {
  await repository.recordRefreshFailure({
    generationId,
    code,
    failedEpochSeconds: Math.max(frozenEpochSeconds, wallEpochSeconds(wallClock)),
  });
}

function release(reservation: PhysicalRequestReservation | null): void {
  reservation?.release();
}

export async function refreshAnalyticsCurves(
  options: RefreshAnalyticsCurvesOptions,
): Promise<AnalyticsCurveRefreshOutcome> {
  const athleteId = nonempty(options.athleteId);
  validateBudget(options.budget);
  if (!Number.isSafeInteger(options.minRequestIntervalMs)
    || options.minRequestIntervalMs < MIN_CONFIGURED_INTERVAL_MS) {
    throw new TypeError("minimum request interval is invalid");
  }
  if (typeof options.httpFactory !== "function" || typeof options.sleep !== "function"
    || typeof options.archive?.writeSnapshot !== "function"
    || typeof options.repository?.beginGeneration !== "function"
    || typeof options.attemptLedger?.tryReserve !== "function") {
    throw new TypeError("analytics curve dependencies are invalid");
  }

  const frozenEpochSeconds = wallEpochSeconds(options.wallClock);
  const frozenAt = new Date(frozenEpochSeconds * 1_000).toISOString();
  const frozenOn = frozenAt.slice(0, 10);
  const { generation } = await options.repository.beginGeneration({ frozenEpochSeconds, frozenOn });
  let physicalRequests = 0;
  let decodedBytes = 0;
  let reservation: PhysicalRequestReservation | null = null;

  if (options.budget.maxRequests < ANALYTICS_CURVE_REQUESTS
    || options.budget.maxArtifacts < ANALYTICS_CURVE_REQUESTS) {
    await recordFailure(options.repository, generation.generationId, frozenEpochSeconds,
      options.wallClock, "request-budget-exhausted");
    return Object.freeze({ kind: "skipped", generationId: generation.generationId, frozenAt,
      physicalRequests, decodedBytes, failure: "request-budget-exhausted" });
  }
  reservation = options.attemptLedger.tryReserve(
    "store",
    "store:analytics-curves",
    ANALYTICS_CURVE_REQUESTS,
  );
  if (reservation === null) {
    await recordFailure(options.repository, generation.generationId, frozenEpochSeconds,
      options.wallClock, "request-budget-exhausted");
    return Object.freeze({ kind: "skipped", generationId: generation.generationId, frozenAt,
      physicalRequests, decodedBytes, failure: "request-budget-exhausted" });
  }

  const laneController = new AbortController();
  const laneStart = monotonicNow(options.budget);
  const laneDeadline = Math.min(
    options.budget.deadlineMonotonicMs,
    laneStart + ANALYTICS_CURVE_LANE_TIMEOUT_MS,
  );
  const timer = setTimeout(
    () => laneController.abort(new Error("analytics curve lane timed out")),
    Math.max(1, Math.min(ANALYTICS_CURVE_LANE_TIMEOUT_MS, laneDeadline - laneStart)),
  );
  const signal = AbortSignal.any([options.budget.signal, laneController.signal]);
  const http = options.httpFactory({
    outer: signal,
    perRequestTimeoutMs: Math.min(
      ANALYTICS_CURVE_REQUEST_TIMEOUT_MS,
      options.budget.perRequestTimeoutMs,
    ),
  });
  const windows = analyticsCurveWindows(frozenOn);
  const selectors = Object.freeze([
    `r.${windows.current.start}.${windows.current.end}`,
    `r.${windows.previous.start}.${windows.previous.end}`,
    `r.${windows.sustainability.start}.${windows.sustainability.end}`,
  ]);
  let lastRequestStart: number | null = null;

  const assertActive = (): void => {
    if (options.budget.signal.aborted) throw new AnalyticsCurveRequestError("cancelled");
    if (laneController.signal.aborted || monotonicNow(options.budget) >= laneDeadline) {
      throw new AnalyticsCurveRequestError("timeout");
    }
  };

  try {
    for (const part of ANALYTICS_CURVE_PARTS) {
      assertActive();
      if (lastRequestStart !== null) {
        const delay = Math.max(
          0,
          lastRequestStart + options.minRequestIntervalMs - monotonicNow(options.budget),
        );
        if (delay > 0) {
          if (monotonicNow(options.budget) + delay >= laneDeadline) {
            throw new AnalyticsCurveRequestError("timeout");
          }
          await options.sleep(delay, signal);
          assertActive();
        }
      }
      reservation.charge();
      physicalRequests += 1;
      lastRequestStart = monotonicNow(options.budget);
      let response: HttpResponse;
      try {
        response = await http.fetch({
          method: "GET",
          url: requestUrl(athleteId, part.curveFamily, part.activityType, selectors),
        });
      } catch {
        if (options.budget.signal.aborted) throw new AnalyticsCurveRequestError("cancelled");
        if (laneController.signal.aborted || monotonicNow(options.budget) >= laneDeadline) {
          throw new AnalyticsCurveRequestError("timeout");
        }
        throw new AnalyticsCurveRequestError("network");
      }
      assertActive();
      if (response.status === 200) decodedBytes += response.body.byteLength;
      const payload = parseResponse(response);
      if (decodedBytes > ANALYTICS_CURVE_MAX_TOTAL_BYTES) {
        throw new AnalyticsCurveRequestError("response-too-large");
      }
      const archived = await options.archive.writeSnapshot(payload, { epochSeconds: frozenEpochSeconds });
      assertActive();
      if (!isValidCurvePayload(part.curveFamily, payload)) {
        throw new AnalyticsCurveRequestError("malformed-response");
      }
      await options.repository.recordEvidence({
        generationId: generation.generationId,
        curveFamily: part.curveFamily,
        activityType: part.activityType,
        archiveAddress: archived.address,
        archiveRelPath: archived.relPath,
        archiveEpochSeconds: frozenEpochSeconds,
        decodedBytes: response.body.byteLength,
      });
      assertActive();
    }
    assertActive();
    const promotedEpochSeconds = Math.max(frozenEpochSeconds, wallEpochSeconds(options.wallClock));
    await options.repository.promoteGeneration({
      generationId: generation.generationId,
      promotedEpochSeconds,
    });
    return Object.freeze({
      kind: "promoted",
      generationId: generation.generationId,
      frozenAt,
      physicalRequests: ANALYTICS_CURVE_REQUESTS,
      decodedBytes,
    });
  } catch (error) {
    const failure = safeFailure(error, options.budget.signal, laneController.signal);
    await recordFailure(options.repository, generation.generationId, frozenEpochSeconds,
      options.wallClock, failure);
    return Object.freeze({ kind: "failed", generationId: generation.generationId, frozenAt,
      physicalRequests, decodedBytes, failure });
  } finally {
    clearTimeout(timer);
    release(reservation);
  }
}
