import { describe, it, expect, vi } from "vitest";
import type { Tool } from "ai";
import {
  memoizeReadTool,
  READ_ONLY_TOOL_NAMES,
  stableStringify,
  memoizeKey,
} from "../src/agent/read-memoizer.js";

const EXPECTED_NAMES = [
  "assess_feasibility",
  "calculate_zones",
  "get_sample_week",
  "intervals_fetch_activities",
  "intervals_fetch_activity",
  "intervals_fetch_athlete",
  "intervals_fetch_streams",
  "intervals_fetch_wellness",
  "intervals_list_events",
  "memory_query",
  "memory_read",
  "plan_load",
];

function makeTool(execute: Tool["execute"]): Tool {
  return { description: "x", inputSchema: {}, execute } as unknown as Tool;
}

describe("READ_ONLY_TOOL_NAMES allowlist", () => {
  it("is exactly the audited read-only set", () => {
    expect([...READ_ONLY_TOOL_NAMES].sort()).toEqual(EXPECTED_NAMES);
  });

  it("excludes every writer tool", () => {
    for (const writer of [
      "build_plan_skeleton",
      "intervals_create_workout",
      "intervals_delete_workout",
      "memory_write",
      "plan_save",
    ]) {
      expect(READ_ONLY_TOOL_NAMES.has(writer)).toBe(false);
    }
  });
});

describe("memoizeReadTool caching", () => {
  it("invokes the inner execute once for identical same-cache calls", async () => {
    const inner = vi.fn(async () => ({ value: 42 }));
    const wrapped = memoizeReadTool(
      "intervals_fetch_activities",
      makeTool(inner),
      new Map(),
    );
    const exec = wrapped.execute as (i: unknown, o: unknown) => Promise<unknown>;
    const first = await exec({ oldest: "1998-01-01" }, {});
    const second = await exec({ oldest: "1998-01-01" }, {});
    expect(inner).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ value: 42 });
    expect(second).toEqual({ value: 42 });
  });

  it("misses the cache for distinct args", async () => {
    const inner = vi.fn(async () => ({ value: 1 }));
    const wrapped = memoizeReadTool(
      "intervals_fetch_activities",
      makeTool(inner),
      new Map(),
    );
    const exec = wrapped.execute as (i: unknown, o: unknown) => Promise<unknown>;
    await exec({ oldest: "1998-01-01" }, {});
    await exec({ oldest: "1998-02-01" }, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("does not memoize a non-allowlisted writer tool", async () => {
    const inner = vi.fn(async () => ({ created: true }));
    const wrapped = memoizeReadTool("build_plan_skeleton", makeTool(inner), new Map());
    const exec = wrapped.execute as (i: unknown, o: unknown) => Promise<unknown>;
    await exec({ a: 1 }, {});
    await exec({ a: 1 }, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("passes through a tool with no execute untouched", () => {
    const tool = { description: "x", inputSchema: {} } as unknown as Tool;
    expect(memoizeReadTool("memory_read", tool, new Map())).toBe(tool);
  });

  it("re-invokes after the cache is cleared (per-turn lifecycle)", async () => {
    const inner = vi.fn(async () => ({ value: 7 }));
    const cache = new Map<string, unknown>();
    const wrapped = memoizeReadTool("plan_load", makeTool(inner), cache);
    const exec = wrapped.execute as (i: unknown, o: unknown) => Promise<unknown>;
    await exec({ id: "p1" }, {});
    await exec({ id: "p1" }, {});
    expect(inner).toHaveBeenCalledTimes(1);
    cache.clear();
    await exec({ id: "p1" }, {});
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

describe("stableStringify and memoizeKey", () => {
  it("orders object keys deterministically", () => {
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("keys are stable across property order, including nested objects", () => {
    expect(memoizeKey("t", { a: 1, b: 2 })).toBe(memoizeKey("t", { b: 2, a: 1 }));
    expect(memoizeKey("t", { x: { p: 1, q: 2 } })).toBe(
      memoizeKey("t", { x: { q: 2, p: 1 } }),
    );
  });

  it("preserves array order", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(memoizeKey("t", [1, 2])).not.toBe(memoizeKey("t", [2, 1]));
  });
});
