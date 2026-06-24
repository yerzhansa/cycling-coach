import { describe, it, expect } from "vitest";
import type { Tool } from "ai";
import { capToolResult, TOOL_RESULT_SHARE } from "../src/agent/tool-result-cap.js";

const stubTool = (value: unknown): Tool =>
  ({ description: "stub", execute: async () => value }) as unknown as Tool;

describe("capToolResult", () => {
  it("constants pin the configured shares", () => {
    expect(TOOL_RESULT_SHARE).toBe(0.5);
  });

  it("small result passes through byte-identical (same reference)", async () => {
    const value = { watts: [100, 200, 300] };
    const wrapped = capToolResult(stubTool(value), { maxResultTokens: 50_000 });
    const out = await wrapped.execute!({}, {} as never);
    expect(out).toBe(value);
  });

  it("string result under the cap passes through unchanged", async () => {
    const wrapped = capToolResult(stubTool("short answer"), { maxResultTokens: 50_000 });
    const out = await wrapped.execute!({}, {} as never);
    expect(out).toBe("short answer");
  });

  it("oversized stream result is truncated with a count-preserving notice", async () => {
    const big = {
      watts: Array(10800).fill(250),
      heartrate: Array(10800).fill(150),
      cadence: Array(10800).fill(90),
      time: Array(10800).fill(1),
      altitude: Array(10800).fill(500),
    };
    const wrapped = capToolResult(stubTool(big), { maxResultTokens: 50_000 });
    const out = (await wrapped.execute!({}, {} as never)) as {
      truncated: boolean;
      notice: string;
      omittedSamples: number;
    };
    expect(out.truncated).toBe(true);
    expect(out.notice).toMatch(/narrower/i);
    expect(out.omittedSamples).toBeGreaterThan(0);
  });

  it("a tool with no execute is returned unchanged", () => {
    const t = { description: "no-exec" } as unknown as Tool;
    expect(capToolResult(t, { maxResultTokens: 50_000 })).toBe(t);
  });

  it("respects the caller-supplied budget boundary", async () => {
    const value = { watts: Array(200).fill(250) };
    const passes = capToolResult(stubTool(value), { maxResultTokens: 50_000 });
    expect(await passes.execute!({}, {} as never)).toBe(value);

    const capped = capToolResult(stubTool(value), { maxResultTokens: 10 });
    const out = (await capped.execute!({}, {} as never)) as { truncated?: boolean };
    expect(out.truncated).toBe(true);
  });
});
