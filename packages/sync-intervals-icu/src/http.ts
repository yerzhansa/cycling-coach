import { retryAfterMsFromHeaders, retryWithBackoff } from "@enduragent/kernel/concurrency";
import type { ClockPort, HttpPort, HttpRequest, HttpResponse } from "@enduragent/kernel/ports";
import type { PhysicalRequestLedger, SyncBudget } from "@enduragent/kernel/store";

export const REQUEST_ATTEMPTS = 4;
export const REQUEST_BACKOFF_BASE_MS = 1_000;
export const REQUEST_BACKOFF_CAP_MS = 30_000;
export const MIN_CONFIGURED_INTERVAL_MS = 250;

export type IntervalsEndpoint = "activities" | "wellness" | "settings" | "streams" | "bulk-fit" | "fit-file";

export class SyncBudgetExceededError extends Error {
  constructor() {
    super("intervals.icu sync budget exceeded");
    this.name = "SyncBudgetExceededError";
  }
}

export class IntervalsHttpError extends Error {
  readonly endpoint: IntervalsEndpoint;
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(endpoint: IntervalsEndpoint, status: number, retryAfterMs: number | null) {
    super("intervals.icu request failed");
    this.name = "IntervalsHttpError";
    this.endpoint = endpoint;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface IntervalsRequester {
  request(endpoint: IntervalsEndpoint, request: HttpRequest): Promise<HttpResponse>;
  requestsUsed(): number;
  canRequest(count?: number): boolean;
  assertActive(): void;
}

function positiveSafe(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} is invalid`);
}

export function validateBudget(budget: SyncBudget): void {
  positiveSafe(budget.maxRequests, "request budget");
  positiveSafe(budget.maxArtifacts, "artifact budget");
  positiveSafe(budget.perRequestTimeoutMs, "request timeout");
  if (typeof budget.deadlineMonotonicMs !== "number" || !Number.isFinite(budget.deadlineMonotonicMs)
    || budget.deadlineMonotonicMs < 0) throw new TypeError("sync deadline is invalid");
  const now = budget.clock.monotonicNow();
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0) throw new TypeError("sync clock is invalid");
}

export function createRequester(options: {
  readonly http: HttpPort;
  readonly budget: SyncBudget;
  readonly minRequestIntervalMs: number;
  readonly wallClock: Pick<ClockPort, "now">;
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly attemptLedger?: PhysicalRequestLedger;
}): IntervalsRequester {
  validateBudget(options.budget);
  if (!Number.isSafeInteger(options.minRequestIntervalMs) || options.minRequestIntervalMs < MIN_CONFIGURED_INTERVAL_MS) {
    throw new TypeError("minimum request interval is invalid");
  }
  let used = 0;
  let lastAttemptStart: number | null = null;
  const monotonicNow = (): number => {
    const value = options.budget.clock.monotonicNow();
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError("sync clock is invalid");
    return value;
  };
  const assertActive = (): void => {
    if (options.budget.signal.aborted || monotonicNow() >= options.budget.deadlineMonotonicMs) {
      throw new SyncBudgetExceededError();
    }
  };
  const canRequest = (count = 1): boolean => Number.isSafeInteger(count) && count > 0
    && !options.budget.signal.aborted && monotonicNow() < options.budget.deadlineMonotonicMs
    && used + count <= options.budget.maxRequests;

  return {
    requestsUsed: () => used,
    canRequest,
    assertActive,
    async request(endpoint, request) {
      const retryableMethod = request.method === "GET" || (request.method === "POST" && endpoint === "bulk-fit");
      return retryWithBackoff(async () => {
        assertActive();
        if (used >= options.budget.maxRequests) throw new SyncBudgetExceededError();
        if (lastAttemptStart !== null) {
          const delay = Math.max(0, lastAttemptStart + options.minRequestIntervalMs - monotonicNow());
          if (delay > 0) {
            if (monotonicNow() + delay >= options.budget.deadlineMonotonicMs) throw new SyncBudgetExceededError();
            await options.sleep(delay, options.budget.signal);
            assertActive();
          }
        }
        if (used >= options.budget.maxRequests) throw new SyncBudgetExceededError();
        const attemptStart = monotonicNow();
        if (endpoint === "bulk-fit" || endpoint === "fit-file") {
          if (options.attemptLedger !== undefined) throw new SyncBudgetExceededError();
        } else {
          options.attemptLedger?.charge("store", `store:${endpoint}`);
        }
        used += 1;
        lastAttemptStart = attemptStart;
        const response = await options.http.fetch(request);
        if (response.status >= 200 && response.status < 300) return response;
        throw new IntervalsHttpError(endpoint, response.status,
          retryAfterMsFromHeaders(response.headers, options.wallClock.now()));
      }, {
        attempts: REQUEST_ATTEMPTS,
        baseMs: REQUEST_BACKOFF_BASE_MS,
        capMs: REQUEST_BACKOFF_CAP_MS,
        signal: options.budget.signal,
        shouldRetry(error) {
          return retryableMethod && error instanceof IntervalsHttpError
            && [429, 500, 502, 503, 504].includes(error.status);
        },
        retryAfterMs: (error) => error instanceof IntervalsHttpError ? error.retryAfterMs : null,
        retryAfterMode: "lower-bound",
        onRetry({ delayMs }) {
          if (used >= options.budget.maxRequests) throw new SyncBudgetExceededError();
          if (monotonicNow() + delayMs >= options.budget.deadlineMonotonicMs) throw new SyncBudgetExceededError();
        },
        sleep: (ms) => options.sleep(ms, options.budget.signal),
      });
    },
  };
}
