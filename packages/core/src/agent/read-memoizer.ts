import { createHash } from "node:crypto";
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
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        JSON.stringify(key) + ":" + stableStringify((value as Record<string, unknown>)[key]),
    );
  return "{" + entries.join(",") + "}";
}

export function memoizeKey(toolName: string, args: unknown): string {
  // The " " separator cannot appear in a tool name, so it disambiguates
  // the toolName/args boundary without colliding with any name's own bytes.
  return createHash("sha256")
    .update(toolName + " " + stableStringify(args))
    .digest("hex");
}

export function memoizeReadTool(name: string, tool: Tool, cache: Map<string, unknown>): Tool {
  if (!READ_ONLY_TOOL_NAMES.has(name)) return tool;
  const inner = tool.execute;
  if (typeof inner !== "function") return tool;
  return {
    ...tool,
    execute: async (input: unknown, options: unknown) => {
      const key = memoizeKey(name, input);
      if (cache.has(key)) return cache.get(key);
      const result = await (inner as (i: unknown, o: unknown) => unknown)(input, options);
      cache.set(key, result);
      return result;
    },
  } as Tool;
}
