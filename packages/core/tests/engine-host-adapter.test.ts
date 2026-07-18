import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APICallError } from "@ai-sdk/provider";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createEngineHostAdapter } from "../src/agent/engine-host-adapter.js";
import {
  LegacyAthleteStateUnavailableError,
  legacyStateReader,
} from "../src/agent/legacy-athlete-state-reader.js";
import { classifyFailure, extractRetryAfterMs } from "../src/agent/token-utils.js";

function config(dataDir: string): Config {
  return {
    dataSource: "platform",
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      compactModel: "claude-haiku-4-5-20251001",
      apiKey: "test",
    },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
    },
    contextWindowTokens: 1_000_000,
    dataDir,
  };
}

function apiError(statusCode: number, responseHeaders?: Record<string, string>): APICallError {
  return new APICallError({
    message: `status ${statusCode}`,
    url: "https://example.test",
    requestBodyValues: {},
    statusCode,
    responseHeaders,
  });
}

describe("engine host adapter", () => {
  let dataDir: string;
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("projects immutable engine config with independent chat and compact windows", () => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-host-"));
    const { ports } = createEngineHostAdapter({ config: config(dataDir), stateReader: legacyStateReader });
    expect(ports.config).toEqual({
      dataSource: "platform",
      llm: {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        compactModel: "claude-haiku-4-5-20251001",
        apiKey: "test",
      },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
      },
      contextWindowTokens: 1_000_000,
      compactContextWindowTokens: 200_000,
    });
    expect(Object.isFrozen(ports.config)).toBe(true);
    expect(Object.isFrozen(ports.config.llm)).toBe(true);
    expect(Object.isFrozen(ports.config.session)).toBe(true);
  });

  it("wires the exact rejecting legacy athlete-state reader", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "engine-host-"));
    const { ports } = createEngineHostAdapter({ config: config(dataDir), stateReader: legacyStateReader });
    await expect(ports.stateReader.getAthleteState()).rejects.toEqual(
      new LegacyAthleteStateUnavailableError(
        "The legacy positional facade exposes no persisted athlete-state reader.",
      ),
    );
  });

  it("uses one classifier for all eight failure discriminants", () => {
    const timeout = Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" });
    const network = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const server = Object.assign(new Error("server"), { name: "ServerError" });
    expect([
      classifyFailure(new Error("maximum context length exceeded")),
      classifyFailure(timeout),
      classifyFailure(apiError(429)),
      classifyFailure(server),
      classifyFailure(network),
      classifyFailure(apiError(401)),
      classifyFailure(apiError(400)),
      classifyFailure(new Error("unclassified")),
    ]).toEqual([
      "overflow",
      "timeout",
      "rate_limit",
      "server_error",
      "network",
      "auth",
      "invalid_request",
      "unknown",
    ]);
  });

  it("parses retry-after milliseconds and seconds through the injected helper", () => {
    expect(extractRetryAfterMs(apiError(429, { "retry-after-ms": "1250" }))).toBe(1250);
    expect(extractRetryAfterMs(apiError(429, { "retry-after": "3" }))).toBe(3000);
    expect(extractRetryAfterMs(new Error("none"))).toBeNull();
  });
});
