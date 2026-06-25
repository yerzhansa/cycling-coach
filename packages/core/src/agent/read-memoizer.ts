import type { Tool } from "ai";

// Membership requires the tool's `execute` to be side-effect-free: a memoized
// hit returns the cached value WITHOUT re-invoking `execute`, so any tool that
// mutates state on each call must stay off this set. The cautionary case is
// `build_plan_skeleton` — it returns a value AND writes a plan via savePlan, so
// memoizing it would silently skip the write on a duplicate call. This is a
// positive, hand-audited allowlist, NOT the negation of the calendar-write set.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "calculate_zones",
  "assess_feasibility",
  "get_sample_week",
  "intervals_fetch_athlete",
  "intervals_fetch_wellness",
  "intervals_fetch_activity",
  "intervals_fetch_streams",
  "intervals_fetch_activities",
  "intervals_list_events",
  "memory_read",
  "memory_query",
  "plan_load",
]);

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  // Skip undefined-valued keys so the serialization mirrors JSON.stringify
  // (which omits them) instead of collapsing `{a: undefined}` with `{a: null}`.
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => JSON.stringify(key) + ":" + stableStringify(record[key]));
  return "{" + entries.join(",") + "}";
}

export function memoizeKey(toolName: string, args: unknown): string {
  // Used only as an in-memory Map key for the per-turn cache, so the raw
  // string is its own collision-free key — no hashing needed. The " "
  // separator cannot appear in a tool name, so it disambiguates the
  // toolName/args boundary without colliding with any name's own bytes.
  return toolName + " " + stableStringify(args);
}

// A per-turn cache, supplied either directly (the unit-test path) or via a
// resolver that reads the running turn's cache from async-context storage (the
// agent path) so concurrent turns never share or clear each other's entries. A
// resolver returning undefined means "no turn in scope" — the read runs unmemoized.
export type ReadCacheSource =
  | Map<string, unknown>
  | (() => Map<string, unknown> | undefined);

export function memoizeReadTool(name: string, tool: Tool, cache: ReadCacheSource): Tool {
  if (!READ_ONLY_TOOL_NAMES.has(name)) return tool;
  const inner = tool.execute;
  if (typeof inner !== "function") return tool;
  const resolveCache = typeof cache === "function" ? cache : () => cache;
  return {
    ...tool,
    execute: async (input: unknown, options: unknown) => {
      const store = resolveCache();
      const run = () => (inner as (i: unknown, o: unknown) => unknown)(input, options);
      if (store === undefined) return run();
      const key = memoizeKey(name, input);
      const cached = store.get(key);
      if (cached !== undefined) return cached;
      // Cache the in-flight promise (not the resolved value) so two identical
      // reads launched in the same agentic step share one call. A rejected read
      // is evicted so the failure isn't cached as a poisoned promise.
      const pending = Promise.resolve(run());
      store.set(key, pending);
      pending.catch(() => {
        if (store.get(key) === pending) store.delete(key);
      });
      return pending;
    },
  };
}
