import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  aggregateExitCode,
  buildHeader,
  distPreflight,
  parseRunFlags,
  runDirName,
  usage,
} from "./run.js";
import type { ScenarioVerdict } from "./lib/types.js";

describe("flag parsing", () => {
  it("parses each supported invocation", () => {
    expect(parseRunFlags([])).toEqual({ kind: "replay-all" });
    expect(parseRunFlags(["--scenario=inj-01"])).toEqual({ kind: "replay-one", scenario: "inj-01" });
    expect(parseRunFlags(["--self-test"])).toEqual({ kind: "self-test" });
    expect(parseRunFlags(["--record", "--scenario=inj-01"])).toEqual({ kind: "record", scenario: "inj-01" });
    expect(parseRunFlags(["--rebaseline"])).toEqual({ kind: "rebaseline" });
    expect(parseRunFlags(["--tier=live", "--scenario=x"])).toEqual({ kind: "live", scenario: "x" });
  });

  it("rules an unknown flag a usage error (exit 2 path)", () => {
    const parsed = parseRunFlags(["--no-such-flag"]);
    expect(parsed.kind).toBe("usage-error");
    expect(usage()).toContain("pnpm s8a");
  });

  it("rules --record without --scenario a usage error", () => {
    expect(parseRunFlags(["--record"]).kind).toBe("usage-error");
  });
});

describe("dist preflight (exit 2 path)", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reports the missing dist and passes when both exist", () => {
    root = mkdtempSync(join(tmpdir(), "s8a-run-test-"));
    expect(distPreflight(root)).toContain("run pnpm build first");
    for (const rel of ["packages/core/dist", "packages/sport-cycling/dist"]) {
      mkdirSync(join(root, rel), { recursive: true });
      writeFileSync(join(root, rel, "index.js"), "export {};\n", "utf-8");
    }
    expect(distPreflight(root)).toBeNull();
  });
});

describe("run dir naming and header", () => {
  it("produces a colon-free ISO run dir name", () => {
    const name = runDirName(new Date("1998-07-06T09:15:30.123Z"));
    expect(name).toBe("1998-07-06T09-15-30.123Z-s8a");
    expect(name).not.toContain(":");
  });

  it("builds the header record shape", () => {
    const verdicts: ScenarioVerdict[] = [{ scenario: "s", pass: true, failures: [] }];
    const header = buildHeader({
      ts: "1998-07-06T09:00:00.000Z",
      gitSha: "abc123",
      scenarios: ["s"],
      verdicts,
    });
    expect(Object.keys(header)).toEqual(["ts", "gitSha", "harnessVersion", "scenarios", "verdicts"]);
    expect(header.harnessVersion).toBe(1);
  });
});

describe("exit-code aggregation", () => {
  it("pass -> 0, any drift failure -> 1", () => {
    const pass: ScenarioVerdict[] = [
      { scenario: "a", pass: true, failures: [] },
      { scenario: "b", pass: true, failures: [], warns: [{ assertId: "A1", scenario: "b", detail: "w" }] },
    ];
    expect(aggregateExitCode(pass)).toBe(0);
    const drift: ScenarioVerdict[] = [
      { scenario: "a", pass: true, failures: [] },
      { scenario: "b", pass: false, failures: [{ assertId: "A2", scenario: "b", detail: "seeded drift" }] },
    ];
    expect(aggregateExitCode(drift)).toBe(1);
  });
});
