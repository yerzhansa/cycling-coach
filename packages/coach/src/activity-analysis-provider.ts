import { makeAbortableClient } from "@enduragent/core";
import type { AnalysisUnavailableReason } from "@enduragent/coach-contract";
import type {
  ActivityStream,
  ApiError,
  IntervalsClient,
  NormalizedActivityStreams,
} from "intervals-icu-api";
import { ActivityAnalysisComputationError } from "./activity-analysis-service.js";

export const ACTIVITY_STREAM_RESPONSE_LIMIT_BYTES = 16 * 1_024 * 1_024;
export const MAX_PROVIDER_ACTIVITY_REQUESTS_PER_REVISION = 8;
const MAX_STREAM_DESCRIPTORS = 16;
const MAX_STREAM_SAMPLES = 1_000_000;
const MAX_TOTAL_STREAM_SAMPLES = 4_000_000;
const MAX_TRACKED_PROVIDER_REVISIONS = 128;
const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
const REQUESTED_STREAMS = ["time", "watts", "heartrate", "moving"] as const;

export interface ProviderActivityStreamArchive {
  write(input: ProviderActivityStreamArchiveRequest): Promise<void>;
}

export interface ProviderActivityStreamArchiveRequest {
  readonly sourceRevision: string;
  readonly descriptors: readonly ActivityStream[];
  readonly signal: AbortSignal;
}

export type ProviderActivityStreamResult =
  | { readonly kind: "available"; readonly streams: NormalizedActivityStreams }
  | { readonly kind: "unavailable"; readonly reason: AnalysisUnavailableReason };

export interface ProviderActivityStreamReader {
  read(input: ProviderActivityStreamRequest): Promise<ProviderActivityStreamResult>;
}

export interface ProviderActivityStreamRequest {
  readonly providerActivityId: string;
  readonly sourceRevision: string;
  readonly signal: AbortSignal;
}

export interface ProviderActivityAnalysisClient {
  readonly activities: IntervalsClient["activities"];
}

export type ProviderActivityAnalysisClientFactory = (input: {
  readonly apiKey: string;
  readonly athleteId: string;
  readonly signal: AbortSignal;
  readonly baseFetch: typeof globalThis.fetch;
}) => ProviderActivityAnalysisClient;

export interface ProviderActivityAnalysisClientLease {
  readonly client: ProviderActivityAnalysisClient;
  responseLimitExceeded(): boolean;
}

export interface ProviderActivityAnalysisClientAccess {
  open(input: {
    readonly sourceRevision: string;
    readonly signal: AbortSignal;
    readonly maximumBytes: number;
  }): Promise<ProviderActivityAnalysisClientLease>;
}

export function providerActivityFailure(
  error: ApiError,
  responseLimitExceeded: boolean,
  signal: AbortSignal,
): never {
  signal.throwIfAborted();
  if (responseLimitExceeded) throw new ActivityAnalysisComputationError("response-too-large");
  if (error.kind === "RateLimit") throw new ActivityAnalysisComputationError("rate-limited");
  if (error.kind === "Timeout") throw new ActivityAnalysisComputationError("timeout");
  if (error.kind === "Network") throw new ActivityAnalysisComputationError("network");
  if (error.kind === "Validation") throw new ActivityAnalysisComputationError("malformed-response");
  if (error.kind === "NotFound") throw new ActivityAnalysisComputationError("provider-unavailable");
  throw new ActivityAnalysisComputationError("provider-unavailable");
}

function boundedDescriptors(streams: NormalizedActivityStreams): boolean {
  if (streams.descriptors.length > MAX_STREAM_DESCRIPTORS) return false;
  let total = 0;
  for (const descriptor of streams.descriptors) {
    if (!Array.isArray(descriptor.data) || descriptor.data.length > MAX_STREAM_SAMPLES)
      return false;
    total += descriptor.data.length;
    if (total > MAX_TOTAL_STREAM_SAMPLES) return false;
  }
  try {
    return (
      new TextEncoder().encode(JSON.stringify(streams.descriptors)).byteLength <=
      ACTIVITY_STREAM_RESPONSE_LIMIT_BYTES
    );
  } catch {
    return false;
  }
}

export function createBoundedActivityStreamFetch(input: {
  readonly baseFetch: typeof globalThis.fetch;
  readonly noteLimitExceeded: () => void;
  readonly maximumBytes?: number;
}): typeof globalThis.fetch {
  const maximumBytes = input.maximumBytes ?? ACTIVITY_STREAM_RESPONSE_LIMIT_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("activity stream response limit is invalid");
  }
  return async (request, init) => {
    const response = await input.baseFetch(request, init);
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const bytes = Number(declared);
      if (Number.isFinite(bytes) && bytes > maximumBytes) {
        input.noteLimitExceeded();
        await response.body?.cancel();
        throw new Error("activity stream response exceeded its private byte limit");
      }
    }
    if (response.body === null) return response;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        input.noteLimitExceeded();
        await reader.cancel();
        throw new Error("activity stream response exceeded its private byte limit");
      }
      chunks.push(next.value);
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function createProviderActivityAnalysisClientAccess(input: {
  readonly credentials: {
    read(): Promise<{ readonly apiKey: string; readonly athleteId: string }>;
  };
  readonly createClient?: ProviderActivityAnalysisClientFactory;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly maximumRequestsPerRevision?: number;
}): ProviderActivityAnalysisClientAccess {
  const maximumRequests =
    input.maximumRequestsPerRevision ?? MAX_PROVIDER_ACTIVITY_REQUESTS_PER_REVISION;
  if (!Number.isSafeInteger(maximumRequests) || maximumRequests < 1) {
    throw new TypeError("provider activity request budget is invalid");
  }
  const requests = new Map<string, number>();
  const createClient =
    input.createClient ??
    ((options) =>
      makeAbortableClient({
        apiKey: options.apiKey,
        ...(options.athleteId.length === 0 ? {} : { athleteId: options.athleteId }),
        signal: options.signal,
        perRequestMs: PROVIDER_REQUEST_TIMEOUT_MS,
        baseFetch: options.baseFetch,
      }));
  return Object.freeze({
    async open(options: {
      readonly sourceRevision: string;
      readonly signal: AbortSignal;
      readonly maximumBytes: number;
    }) {
      options.signal.throwIfAborted();
      if (!/^[0-9a-f]{64}$/.test(options.sourceRevision)) {
        throw new TypeError("provider activity source revision is invalid");
      }
      const credentials = await input.credentials.read();
      options.signal.throwIfAborted();
      if (credentials.apiKey.length === 0) {
        throw new ActivityAnalysisComputationError("provider-unavailable");
      }
      const used = requests.get(options.sourceRevision) ?? 0;
      if (used >= maximumRequests) {
        throw new ActivityAnalysisComputationError("request-budget-exhausted");
      }
      requests.delete(options.sourceRevision);
      requests.set(options.sourceRevision, used + 1);
      while (requests.size > MAX_TRACKED_PROVIDER_REVISIONS) {
        const oldest = requests.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        requests.delete(oldest);
      }
      let exceeded = false;
      const client = createClient({
        apiKey: credentials.apiKey,
        athleteId: credentials.athleteId,
        signal: options.signal,
        baseFetch: createBoundedActivityStreamFetch({
          baseFetch: input.baseFetch ?? globalThis.fetch,
          maximumBytes: options.maximumBytes,
          noteLimitExceeded: () => {
            exceeded = true;
          },
        }),
      });
      return Object.freeze({
        client,
        responseLimitExceeded: () => exceeded,
      });
    },
  });
}

export function createProviderActivityStreamReader(input: {
  readonly access: ProviderActivityAnalysisClientAccess;
  readonly archive: ProviderActivityStreamArchive;
}): ProviderActivityStreamReader {
  const reader: ProviderActivityStreamReader = {
    async read(request: ProviderActivityStreamRequest) {
      request.signal.throwIfAborted();
      const lease = await input.access.open({
        sourceRevision: request.sourceRevision,
        signal: request.signal,
        maximumBytes: ACTIVITY_STREAM_RESPONSE_LIMIT_BYTES,
      });
      const result = await lease.client.activities.getStreamMap(request.providerActivityId, {
        types: REQUESTED_STREAMS,
        includeDefaults: false,
      });
      request.signal.throwIfAborted();
      if (!result.ok) {
        providerActivityFailure(result.error, lease.responseLimitExceeded(), request.signal);
      }
      if (!boundedDescriptors(result.value)) {
        throw new ActivityAnalysisComputationError("response-too-large");
      }
      await input.archive.write({
        sourceRevision: request.sourceRevision,
        descriptors: result.value.descriptors,
        signal: request.signal,
      });
      request.signal.throwIfAborted();
      return { kind: "available" as const, streams: result.value };
    },
  };
  return Object.freeze(reader);
}
