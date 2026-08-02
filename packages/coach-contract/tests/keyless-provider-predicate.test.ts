import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import {
  KEYLESS_LLM_PROVIDERS,
  LlmProviderSchema,
  ConfigureRuntimeRpcParamsSchema,
  isKeylessProvider,
} from "../src/rpc.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCANNED_GROUPS = ["packages", "apps"] as const;
const DEFINITION_SITE = join("packages", "coach-contract", "src", "rpc.ts");

const CODEX = "openai" + "-codex";
const CLAUDE_CLI = "claude" + "-cli";
const CODEX_AGENT = "codex" + "-agent";
const WINDOW = 96;
const comparison = (literal: string): string => `(?:===|!==)\\s*"${literal}"`;
const ordered = (first: string, second: string): string =>
  `${comparison(first)}[\\s\\S]{0,${WINDOW}}?${comparison(second)}`;
const DISJUNCTION = new RegExp(
  `${ordered(CODEX, CLAUDE_CLI)}|${ordered(CLAUDE_CLI, CODEX)}`,
  "g",
);

function sourceFiles(): readonly string[] {
  const found: string[] = [];
  const walk = (absolute: string, relative: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const nextAbsolute = join(absolute, entry.name);
      const nextRelative = join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(nextAbsolute, nextRelative);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
      found.push(nextRelative);
    }
  };
  for (const group of SCANNED_GROUPS) {
    for (const packageDir of readdirSync(join(REPO_ROOT, group))) {
      const absolute = join(REPO_ROOT, group, packageDir, "src");
      try {
        if (!statSync(absolute).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(absolute, join(group, packageDir, "src"));
    }
  }
  return found;
}

describe("keyless provider predicate", () => {
  it("names exactly the providers that carry no api key", () => {
    expect([...KEYLESS_LLM_PROVIDERS]).toEqual([CODEX, CLAUDE_CLI, CODEX_AGENT]);
    for (const provider of KEYLESS_LLM_PROVIDERS) {
      expect(LlmProviderSchema.safeParse(provider).success).toBe(true);
      expect(isKeylessProvider(provider)).toBe(true);
    }
    expect(isKeylessProvider("anthropic")).toBe(false);
    expect(isKeylessProvider("")).toBe(false);
  });

  it("rejects an api key for every keyless provider and accepts one otherwise", () => {
    for (const provider of KEYLESS_LLM_PROVIDERS) {
      const rejected = ConfigureRuntimeRpcParamsSchema.safeParse({ llm: { provider, api_key: "sk-test" } });
      expect(rejected.success).toBe(false);
      expect(ConfigureRuntimeRpcParamsSchema.safeParse({ llm: { provider } }).success).toBe(true);
    }
    expect(
      ConfigureRuntimeRpcParamsSchema.safeParse({ llm: { provider: "anthropic", api_key: "sk-test" } })
        .success,
    ).toBe(true);
  });

  it("finds the scanned source tree", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(DEFINITION_SITE);
  });

  it("has no hand-written keyless disjunction outside the definition site", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === DEFINITION_SITE) continue;
      const text = readFileSync(join(REPO_ROOT, file), "utf-8");
      DISJUNCTION.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = DISJUNCTION.exec(text)) !== null) {
        offenders.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("still detects a hand-written disjunction when one is present", () => {
    const sample = `if (provider === "${CODEX}" || provider === "${CLAUDE_CLI}") return true;`;
    DISJUNCTION.lastIndex = 0;
    expect(DISJUNCTION.test(sample)).toBe(true);
    DISJUNCTION.lastIndex = 0;
    expect(DISJUNCTION.test(`if (provider === "${CODEX}") return true;`)).toBe(false);
  });
});
