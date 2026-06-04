// Tests for the cache-path / skip-if-cached / CLI-window logic of
// `tools/fetch-streams.ts`. The network is mocked; only the pure helpers and
// the idempotent caching loop are exercised.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  basicAuthHeader,
  cacheActivityStreams,
  parseArgs,
  resolveWindow,
  STREAM_TYPES,
  streamCachePath,
} from "./fetch-streams.js";

describe("parseArgs", () => {
  it("defaults to a 42-day window with no limit", () => {
    expect(parseArgs([])).toEqual({ days: 42 });
  });

  it("parses the window + limit flags", () => {
    expect(parseArgs(["--days", "14", "--limit", "3"])).toEqual({
      days: 14,
      limit: 3,
    });
    expect(parseArgs(["--oldest", "2026-01-01", "--newest", "2026-02-01"])).toEqual({
      days: 42,
      oldest: "2026-01-01",
      newest: "2026-02-01",
    });
  });

  it("rejects unknown flags and missing values", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown flag/);
    expect(() => parseArgs(["--days"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--days", "--limit"])).toThrow(/requires a value/);
  });
});

describe("resolveWindow", () => {
  it("honors explicit oldest/newest verbatim", () => {
    expect(resolveWindow({ days: 42, oldest: "2026-03-01", newest: "2026-03-31" })).toEqual({
      oldest: "2026-03-01",
      newest: "2026-03-31",
    });
  });

  it("derives a trailing window from --days when bounds are absent", () => {
    const { oldest, newest } = resolveWindow({ days: 7 });
    expect(oldest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(newest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const span =
      (Date.parse(`${newest}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) /
      (24 * 60 * 60 * 1000);
    expect(span).toBe(7);
  });
});

describe("basicAuthHeader", () => {
  it("matches the intervals.icu API_KEY-as-username Basic scheme", () => {
    // base64("API_KEY:secret") — the key value is never logged, only encoded.
    expect(basicAuthHeader("secret")).toBe(
      `Basic ${Buffer.from("API_KEY:secret").toString("base64")}`,
    );
    expect(basicAuthHeader("secret")).toMatch(/^Basic /);
  });
});

describe("cacheActivityStreams", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "fetch-streams-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("writes one cache file per activity and requests the documented channels", async () => {
    const requested: string[][] = [];
    const counts = await cacheActivityStreams(
      cacheRoot,
      ["111", "222"],
      async (_id, types) => {
        requested.push([...types]);
        return { ok: true, value: [{ type: "watts", data: [1, 2, 3] }] };
      },
      { throttleMs: 0 },
    );

    expect(counts).toEqual({ fetched: 2, skipped: 0 });
    expect(existsSync(streamCachePath(cacheRoot, "111"))).toBe(true);
    expect(existsSync(streamCachePath(cacheRoot, "222"))).toBe(true);
    expect(requested[0]).toEqual([...STREAM_TYPES]);
    const written = JSON.parse(readFileSync(streamCachePath(cacheRoot, "111"), "utf-8"));
    expect(written).toEqual([{ type: "watts", data: [1, 2, 3] }]);
  });

  it("skips activities whose cache file already exists (idempotent)", async () => {
    writeFileSync(streamCachePath(cacheRoot, "111"), "[]");
    let calls = 0;
    const counts = await cacheActivityStreams(
      cacheRoot,
      ["111", "222"],
      async () => {
        calls++;
        return { ok: true, value: [] };
      },
      { throttleMs: 0 },
    );

    expect(counts).toEqual({ fetched: 1, skipped: 1 });
    expect(calls).toBe(1);
  });

  it("does not write a cache file when the fetch fails", async () => {
    const logs: string[] = [];
    const counts = await cacheActivityStreams(
      cacheRoot,
      ["333"],
      async () => ({ ok: false, error: "boom" }),
      { throttleMs: 0, log: (m) => logs.push(m) },
    );

    expect(counts).toEqual({ fetched: 0, skipped: 0 });
    expect(existsSync(streamCachePath(cacheRoot, "333"))).toBe(false);
    expect(logs.join("\n")).toMatch(/failed/);
  });
});
