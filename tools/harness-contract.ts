/**
 * TypeScript loader for the language-neutral harness contract
 * (`tools/harness-contract.json`). The JSON is the single source of truth for
 * the literal data the snapshot harness and its three twins must share; the
 * two Python twins read the same file via `json.load`. Keeping the read here
 * (resolved relative to this file, not cwd) means both TS call sites — the
 * pyodide harness and the fuzz-parity differential — agree on one parse.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface HarnessContract {
  optionalFixturePaths: string[];
  fuzzOnlyOptionalPaths: string[];
  conditionalKwargs: Record<string, string>;
  powerCurveDeltaWindowDaysAgo: {
    win1StartDaysAgo: number;
    win2StartDaysAgo: number;
    win2EndDaysAgo: number;
  };
}

const CONTRACT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "harness-contract.json",
);

function stripComments<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripComments(v)) as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "$comment") continue;
      out[k] = stripComments(v);
    }
    return out as T;
  }
  return value;
}

export const HARNESS_CONTRACT: HarnessContract = stripComments(
  JSON.parse(readFileSync(CONTRACT_PATH, "utf8")) as HarnessContract,
);

/** Allowlist the snapshot harness enforces (no fuzz-only extras). */
export const OPTIONAL_FIXTURE_PATHS: readonly string[] =
  HARNESS_CONTRACT.optionalFixturePaths;

/**
 * Allowlist the fuzz differential enforces — the canonical set plus the
 * fuzz-only optionalities its perturbation legitimately produces.
 */
export const FUZZ_OPTIONAL_FIXTURE_PATHS: readonly string[] = [
  ...HARNESS_CONTRACT.optionalFixturePaths,
  ...HARNESS_CONTRACT.fuzzOnlyOptionalPaths,
];
