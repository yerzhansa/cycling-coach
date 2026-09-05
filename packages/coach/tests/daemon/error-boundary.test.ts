import { describe, expect, it } from "vitest";
import { JsonValueSchema } from "@enduragent/coach-contract";
import { serializeBoundaryError } from "../../src/daemon/error-boundary.js";

const SENTINEL = "[redacted]";

function encoded(value: unknown): string {
  return JSON.stringify(value);
}

describe("boundary error serialization", () => {
  it("drops free text and provider payloads while preserving safe structure", () => {
    const nested = {
      token: "synthetic-nested-token",
      detail: "synthetic-arbitrary-text",
    };
    const error = Object.assign(new Error("synthetic-message-secret"), {
      apiKey: "synthetic-api-key",
      authorization: "synthetic-authorization",
      statusCode: 503,
      nested,
      values: [{ cookie: "synthetic-cookie", count: 2 }],
      url: "https://example.invalid/synthetic-url-secret",
      provider: "synthetic-provider-secret",
      requestBodyValues: { apiKey: "synthetic-request-secret" },
      responseBody: "synthetic-response-secret",
      payload: "synthetic-payload-secret",
      body: "synthetic-body-secret",
      data: "synthetic-data-secret",
      active: true,
      retryAfter: null,
    });
    Object.defineProperty(error, "stack", {
      configurable: true,
      value: "Error: synthetic-stack-secret",
    });

    const payload = serializeBoundaryError(error);

    expect(payload).toEqual({
      name: "Error",
      statusCode: 503,
      apiKey: SENTINEL,
      authorization: SENTINEL,
      nested: { token: SENTINEL, detail: SENTINEL },
      values: [{ cookie: SENTINEL, count: 2 }],
      active: true,
      retryAfter: null,
    });
    for (const key of [
      "message",
      "stack",
      "url",
      "provider",
      "requestBodyValues",
      "responseBody",
      "payload",
      "body",
      "data",
    ]) {
      expect(payload).not.toHaveProperty(key);
    }
    for (const secret of [
      "synthetic-message-secret",
      "synthetic-stack-secret",
      "synthetic-url-secret",
      "synthetic-provider-secret",
      "synthetic-request-secret",
      "synthetic-response-secret",
      "synthetic-payload-secret",
      "synthetic-body-secret",
      "synthetic-data-secret",
      "synthetic-arbitrary-text",
    ]) {
      expect(encoded(payload)).not.toContain(secret);
    }
    expect(error.apiKey).toBe("synthetic-api-key");
    expect(error.nested).toBe(nested);
    expect(nested).toEqual({
      token: "synthetic-nested-token",
      detail: "synthetic-arbitrary-text",
    });
    expect(JsonValueSchema.parse(payload)).toEqual(payload);
  });

  it("bounds cycles and the effective second-walk depth", () => {
    const circular: Record<string, unknown> = { count: 1 };
    circular.self = circular;
    const error = Object.assign(new Error("synthetic"), {
      circular,
      fiveLevels: { two: { three: { four: { five: { count: 5 } } } } },
      sixLevels: { two: { three: { four: { five: { six: { count: 6 } } } } } },
    });

    const payload = serializeBoundaryError(error);

    expect(payload.circular).toEqual({ count: 1, self: SENTINEL });
    expect(payload.fiveLevels).toEqual({
      two: { three: { four: { five: { count: 5 } } } },
    });
    expect(payload.sixLevels).toEqual({
      two: { three: { four: { five: { six: SENTINEL } } } },
    });
    expect(circular.self).toBe(circular);
    expect(JsonValueSchema.parse(payload)).toEqual(payload);
  });

  it("suppresses non-errors and every non-JSON diagnostic value", () => {
    const nonError = {
      toString: () => "synthetic-non-error-secret",
    };
    const error = Object.assign(new Error("synthetic-message-secret"), {
      diagnosticNote: "synthetic-diagnostic-secret",
      finite: 7,
      infinite: Number.POSITIVE_INFINITY,
      enabled: false,
      empty: null,
      callable: () => "synthetic-function-secret",
      symbolic: Symbol("synthetic-symbol-secret"),
    });

    expect(serializeBoundaryError(nonError)).toEqual({ name: "NonError" });
    const payload = serializeBoundaryError(error);
    expect(payload).toEqual({
      name: "Error",
      diagnosticNote: SENTINEL,
      finite: 7,
      infinite: SENTINEL,
      enabled: false,
      empty: null,
      callable: SENTINEL,
      symbolic: SENTINEL,
    });
    const output = encoded(payload);
    for (const secret of [
      "synthetic-message-secret",
      "synthetic-diagnostic-secret",
      "synthetic-function-secret",
      "synthetic-symbol-secret",
      "synthetic-non-error-secret",
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(JsonValueSchema.parse(payload)).toEqual(payload);
  });

  it("never invokes hostile error properties and preserves safe diagnostics", () => {
    let callbacks = 0;
    const throwingName = new Error("synthetic");
    Object.defineProperty(throwingName, "name", {
      get() {
        callbacks++;
        throw new Error("synthetic-name-getter-secret");
      },
    });
    expect(serializeBoundaryError(throwingName)).toEqual({
      name: "Error",
    });

    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          callbacks++;
          throw new Error("synthetic-proxy-secret");
        },
      },
    );
    for (const field of ["url", "provider"] as const) {
      const error = Object.assign(new Error("synthetic"), { [field]: hostile });
      expect(serializeBoundaryError(error)).toEqual({ name: "Error" });
    }
    expect(
      serializeBoundaryError(Object.assign(new Error("synthetic"), { statusCode: hostile })),
    ).toEqual({ name: "Error", statusCode: SENTINEL });
    expect(
      serializeBoundaryError(Object.assign(new Error("synthetic"), { diagnostic: hostile })),
    ).toEqual({ name: "Error", diagnostic: SENTINEL });
    expect(callbacks).toBe(0);
  });
});
