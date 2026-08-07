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
const MAX_STREAM_DESCRIPTORS = 16;
const MAX_STREAM_SAMPLES = 1_000_000;
const MAX_TOTAL_STREAM_SAMPLES = 4_000_000;
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

interface ProviderStreamClient {
  readonly activities: Pick<IntervalsClient["activities"], "getStreamMap">;
}

type ProviderStreamClientFactory = (input: {
  readonly apiKey: string;
  readonly athleteId: string;
  readonly signal: AbortSignal;
  readonly baseFetch: typeof globalThis.fetch;
}) => ProviderStreamClient;

function failure(error: ApiError, responseLimitExceeded: boolean, signal: AbortSignal): never {
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

export function createProviderActivityStreamReader(input: {
  readonly credentials: {
    read(): Promise<{ readonly apiKey: string; readonly athleteId: string }>;
  };
  readonly archive: ProviderActivityStreamArchive;
  readonly createClient?: ProviderStreamClientFactory;
  readonly baseFetch?: typeof globalThis.fetch;
}): ProviderActivityStreamReader {
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
  const reader: ProviderActivityStreamReader = {
    async read(request: ProviderActivityStreamRequest) {
      request.signal.throwIfAborted();
      const credentials = await input.credentials.read();
      request.signal.throwIfAborted();
      if (credentials.apiKey.length === 0) {
        throw new ActivityAnalysisComputationError("provider-unavailable");
      }
      let responseLimitExceeded = false;
      const client = createClient({
        apiKey: credentials.apiKey,
        athleteId: credentials.athleteId,
        signal: request.signal,
        baseFetch: createBoundedActivityStreamFetch({
          baseFetch: input.baseFetch ?? globalThis.fetch,
          noteLimitExceeded: () => {
            responseLimitExceeded = true;
          },
        }),
      });
      const result = await client.activities.getStreamMap(request.providerActivityId, {
        types: REQUESTED_STREAMS,
        includeDefaults: false,
      });
      request.signal.throwIfAborted();
      if (!result.ok) failure(result.error, responseLimitExceeded, request.signal);
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
