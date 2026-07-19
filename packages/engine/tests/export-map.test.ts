import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as engine from "../src/index.js";
import type { ChatStreamTimeouts } from "../src/index.js";

const timeoutTypeProof: ChatStreamTimeouts = { ttftMs: 1, interChunkMs: 1 };

describe("engine public export surface", () => {
  it("keeps only the root and sport package subpaths", () => {
    const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8")) as {
      exports: Record<string, unknown>;
    };
    expect(Object.keys(packageJson.exports).sort()).toEqual([".", "./sport"]);
  });

  it("exports only the canonical factory and the authorized JWT account helper at runtime", () => {
    expect(Object.keys(engine).sort()).toEqual([
      "cacheReadSavingsUsd",
      "classifySpendCaching",
      "createCoachEngine",
      "extractAccountId",
      "priceInclusiveUsage",
    ]);
    expect(timeoutTypeProof).toEqual({ ttftMs: 1, interChunkMs: 1 });
    expect("DEFAULT_CHAT_STREAM_TIMEOUTS" in engine).toBe(false);
  });

  it("retains the Core test helper only as a pure re-export", () => {
    const shimPath = fileURLToPath(
      new URL("../../core/tests/helpers/base-agent-config.ts", import.meta.url),
    );
    const source = readFileSync(shimPath, "utf-8");
    expect(source.trim()).toBe(
      'export * from "../../../engine/tests/helpers/base-agent-config.js";',
    );
    expect(source).not.toMatch(/\b(?:function|class|const|let|var)\b/);
  });
});
