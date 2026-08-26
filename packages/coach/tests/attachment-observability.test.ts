import { describe, expect, it, vi } from "vitest";
import type { LoggerPort } from "@enduragent/engine";
import {
  attachmentByteBucket,
  attachmentCountBucket,
  attachmentDurationBucket,
  observeChatAttachment,
} from "../src/attachment-observability.js";

function logger() {
  const info = vi.fn();
  const value: LoggerPort = {
    debug: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { value, info };
}

describe("Chat attachment observability", () => {
  it("uses bounded buckets instead of exact sizes, durations, or counts", () => {
    expect([0, 1_023, 1_024, 1_048_576, 10_485_760, 104_857_600].map(attachmentByteBucket)).toEqual(
      ["lt_1_kib", "lt_1_kib", "lt_1_mib", "lt_10_mib", "lt_100_mib", "gte_100_mib"],
    );
    expect([0, 9, 10, 100, 1_000, 10_000].map(attachmentDurationBucket)).toEqual([
      "lt_10_ms",
      "lt_10_ms",
      "lt_100_ms",
      "lt_1_s",
      "lt_10_s",
      "gte_10_s",
    ]);
    expect([0, 1, 2, 5, 6, 20, 21].map(attachmentCountBucket)).toEqual([
      "0",
      "1",
      "2_5",
      "2_5",
      "6_20",
      "6_20",
      "gte_21",
    ]);
  });

  it("emits only the privacy-safe allowlist and drops an unsafe parser version", () => {
    const log = logger();
    const privateMarker = "/Users/athlete/private/ride-secret.fit";

    observeChatAttachment(log.value, {
      operation: "preprocess",
      kind: "activity",
      result: "ready",
      byteSize: 4_096,
      durationMs: 52,
      count: 1,
      parserVersion: privateMarker,
    });

    expect(log.info).toHaveBeenCalledWith("chat_attachment_operation", {
      operation: "preprocess",
      kind: "activity",
      result_code: "ready",
      byte_bucket: "lt_1_mib",
      duration_bucket: "lt_100_ms",
      count_bucket: "1",
    });
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(privateMarker);
  });

  it("includes a validated internal parser version without accepting arbitrary fields", () => {
    const log = logger();
    observeChatAttachment(log.value, {
      operation: "preprocess",
      kind: "workout",
      result: "ready",
      parserVersion: "cycling-workout-v1",
    });

    expect(log.info.mock.calls[0]?.[1]).toEqual({
      operation: "preprocess",
      kind: "workout",
      result_code: "ready",
      byte_bucket: "unknown",
      duration_bucket: "unknown",
      count_bucket: "unknown",
      parser_version: "cycling-workout-v1",
    });
  });

  it("never lets a diagnostics write break attachment work", () => {
    const value: LoggerPort = {
      debug: vi.fn(),
      info: vi.fn(() => {
        throw new Error("log storage full");
      }),
      warn: vi.fn(),
      error: vi.fn(),
    };

    expect(() =>
      observeChatAttachment(value, {
        operation: "cleanup",
        kind: "unknown",
        result: "succeeded",
      }),
    ).not.toThrow();
  });
});
