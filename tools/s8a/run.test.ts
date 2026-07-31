import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  aggregateExitCode,
  buildChildEnv,
  buildHeader,
  distPreflight,
  parseRecordingLane,
  parseRunFlags,
  resolveRecordLane,
  runDirName,
  usage,
} from "./run.js";
import { AUTH_PROFILES_SOURCE_ENV } from "./lib/codex-auth.js";
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

describe("recording-header lane", () => {
  it("reads provider and model off the header", () => {
    expect(parseRecordingLane('{"provider":"openai-codex","model":"gpt-5.6-sol"}')).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
    });
    expect(parseRecordingLane('{"provider":"anthropic","model":"claude-sonnet-4-6"}')).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("falls back to the legacy lane for an absent, unparseable, or unknown header", () => {
    const legacy = { provider: "anthropic", model: "claude-sonnet-4-6" };
    expect(parseRecordingLane(null)).toEqual(legacy);
    expect(parseRecordingLane("{not json")).toEqual(legacy);
    expect(parseRecordingLane('{"provider":"openai","model":"gpt-4o"}')).toEqual({
      provider: "anthropic",
      model: "gpt-4o",
    });
    expect(parseRecordingLane('{"provider":"openai-codex"}')).toEqual({
      provider: "openai-codex",
      model: "gpt-5.6-sol",
    });
  });
});

describe("record-lane resolution", () => {
  it("defaults to the codex lane and its default model", () => {
    expect(resolveRecordLane({})).toEqual({
      ok: true,
      lane: { provider: "openai-codex", model: "gpt-5.6-sol" },
    });
  });

  it("honors an explicit provider and model pin", () => {
    expect(resolveRecordLane({ LLM_PROVIDER: "anthropic" })).toEqual({
      ok: true,
      lane: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    expect(resolveRecordLane({ LLM_PROVIDER: "openai-codex", LLM_MODEL: "gpt-5.6-luna" })).toEqual({
      ok: true,
      lane: { provider: "openai-codex", model: "gpt-5.6-luna" },
    });
  });

  it("rejects a provider the harness cannot record", () => {
    const resolved = resolveRecordLane({ LLM_PROVIDER: "openrouter" });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain("anthropic | openai-codex");
  });
});

describe("child spawn env", () => {
  const base = {
    ANTHROPIC_API_KEY: "operator-real-key",
    [AUTH_PROFILES_SOURCE_ENV]: "/operator/auth-profiles.json",
    LLM_BASE_URL: "https://stray.example",
    HISTORY_TOKEN_BUDGET_RATIO: "0.9",
  };

  it("carries zero credentials into a codex-lane replay child", () => {
    const env = buildChildEnv({
      base,
      tempHome: "/tmp/s8a-home-x",
      provider: "openai-codex",
      llmModel: "gpt-5.6-sol",
    });
    expect(env.LLM_PROVIDER).toBe("openai-codex");
    expect(env.LLM_MODEL).toBe("gpt-5.6-sol");
    expect(env.CYCLING_COACH_HOME).toBe("/tmp/s8a-home-x");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env[AUTH_PROFILES_SOURCE_ENV]).toBeUndefined();
    expect(env.LLM_API_KEY).toBeUndefined();
    expect(env.LLM_BASE_URL).toBeUndefined();
    expect(env.HISTORY_TOKEN_BUDGET_RATIO).toBeUndefined();
  });

  it("scrubs the operator's real key on an anthropic-lane replay child", () => {
    const env = buildChildEnv({
      base,
      tempHome: "/tmp/s8a-home-x",
      provider: "anthropic",
      llmModel: "claude-sonnet-4-6",
      anthropicKey: "s8a-replay-dummy",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("s8a-replay-dummy");
    expect(env[AUTH_PROFILES_SOURCE_ENV]).toBeUndefined();
  });

  it("hands the codex record child its profiles source and no api key", () => {
    const env = buildChildEnv({
      base,
      tempHome: "/tmp/s8a-home-x",
      provider: "openai-codex",
      llmModel: "gpt-5.6-sol",
      authProfilesSource: "/operator/config/auth-profiles.json",
      scenarioEnv: { HISTORY_TOKEN_BUDGET_RATIO: "0.05" },
    });
    expect(env[AUTH_PROFILES_SOURCE_ENV]).toBe("/operator/config/auth-profiles.json");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HISTORY_TOKEN_BUDGET_RATIO).toBe("0.05");
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
