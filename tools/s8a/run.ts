// Parent orchestrator. It spawns one fresh child process per scenario (the
// coach home env var must land before the child imports the core package, whose
// config dir is resolved at import time) and never constructs the agent itself.
// The parent's clock is never frozen: two consecutive runs always land in
// distinct run dirs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectSessionLineage } from "./lib/asserts.js";
import { canRebaseline, rebaselineFixture } from "./lib/rebaseline.js";
import { S8A_ATHLETE_ID } from "./scenarios/common.js";
import { selectScenarios, type ManifestEntry } from "./lib/scenario-filter.js";
import type { S8aScenario, ScenarioVerdict } from "./lib/types.js";
import { SCENARIO_MANIFEST } from "./scenarios/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const RECORD_MODEL_DEFAULT = "claude-sonnet-4-6";
const REPLAY_DUMMY_KEY = "s8a-replay-dummy";

// Stray operator knobs would silently change the child's model lane, budgets,
// or session policy and break replay determinism. Source of truth for what
// core reads from the environment: packages/core/src/config.ts — any env knob
// added there that alters turn behavior belongs on this list.
const SCRUBBED_ENV_KNOBS = [
  "LLM_FLUSH_MODEL",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "SESSION_IDLE_MINUTES",
  "SESSION_DAILY_RESET_HOUR",
  "SESSION_RESET_ARCHIVE_RETENTION_DAYS",
  "CONTEXT_WINDOW_TOKENS",
] as const;

export type RunFlags =
  | { kind: "replay-all" }
  | { kind: "replay-one"; scenario: string }
  | { kind: "self-test" }
  | { kind: "record"; scenario: string }
  | { kind: "rebaseline" }
  | { kind: "live"; scenario: string }
  | { kind: "usage-error"; message: string };

export function parseRunFlags(argv: string[]): RunFlags {
  let scenario: string | undefined;
  let selfTest = false;
  let record = false;
  let rebaseline = false;
  let tier: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("--scenario=")) scenario = arg.slice("--scenario=".length);
    else if (arg === "--self-test") selfTest = true;
    else if (arg === "--record") record = true;
    else if (arg === "--rebaseline") rebaseline = true;
    else if (arg.startsWith("--tier=")) tier = arg.slice("--tier=".length);
    else return { kind: "usage-error", message: `unknown flag: ${arg}` };
  }
  if (tier !== undefined && tier !== "live") {
    return { kind: "usage-error", message: `unknown tier: ${tier}` };
  }
  if (selfTest) {
    if (scenario !== undefined || record || rebaseline || tier !== undefined) {
      return { kind: "usage-error", message: "--self-test takes no other flags" };
    }
    return { kind: "self-test" };
  }
  if (record) {
    if (scenario === undefined) return { kind: "usage-error", message: "--record requires --scenario=<id>" };
    return { kind: "record", scenario };
  }
  if (rebaseline) {
    if (scenario !== undefined || tier !== undefined) {
      return { kind: "usage-error", message: "--rebaseline takes no other flags" };
    }
    return { kind: "rebaseline" };
  }
  if (tier === "live") {
    if (scenario === undefined) return { kind: "usage-error", message: "--tier=live requires --scenario=<id>" };
    return { kind: "live", scenario };
  }
  if (scenario !== undefined) return { kind: "replay-one", scenario };
  return { kind: "replay-all" };
}

export function usage(): string {
  return [
    "usage: pnpm s8a [--scenario=<id>] [--self-test] [--record --scenario=<id>] [--rebaseline] [--tier=live --scenario=<id>]",
  ].join("\n");
}

export function distPreflight(repoRoot: string): string | null {
  for (const rel of ["packages/core/dist/index.js", "packages/sport-cycling/dist/index.js"]) {
    if (!existsSync(join(repoRoot, rel))) {
      return `missing ${rel} — run pnpm build first`;
    }
  }
  return null;
}

export function runDirName(instant: Date): string {
  return `${instant.toISOString().replace(/:/g, "-")}-s8a`;
}

export interface RunHeader {
  ts: string;
  gitSha: string;
  harnessVersion: 1;
  scenarios: string[];
  verdicts: ScenarioVerdict[];
}

export function buildHeader(params: {
  ts: string;
  gitSha: string;
  scenarios: string[];
  verdicts: ScenarioVerdict[];
}): RunHeader {
  return {
    ts: params.ts,
    gitSha: params.gitSha,
    harnessVersion: 1,
    scenarios: params.scenarios,
    verdicts: params.verdicts,
  };
}

/** 0 all green; 1 any assert failure; harness errors exit 2 before this point. */
export function aggregateExitCode(verdicts: ScenarioVerdict[]): 0 | 1 {
  return verdicts.every((v) => v.pass) ? 0 : 1;
}

interface ChildOutcome {
  verdict: ScenarioVerdict | null;
  exitCode: number;
  stderr: string;
}

function spawnScenarioChild(params: {
  scenarioId: string;
  mode: "replay" | "record";
  runDir: string;
  fixtureDir?: string;
  noSupersessions?: boolean;
  scenarioEnv?: Record<string, string>;
  llmModel: string;
  anthropicKey: string;
}): ChildOutcome {
  const tempHome = mkdtempSync(join(tmpdir(), "s8a-home-"));
  const childArgs = [
    join(HERE, "run-scenario.ts"),
    `--scenario=${params.scenarioId}`,
    `--mode=${params.mode}`,
    `--run-dir=${params.runDir}`,
    ...(params.fixtureDir !== undefined ? [`--fixture-dir=${params.fixtureDir}`] : []),
    ...(params.noSupersessions === true ? ["--no-supersessions"] : []),
  ];
  const env: Record<string, string | undefined> = {
    ...process.env,
    CYCLING_COACH_HOME: tempHome,
    LLM_PROVIDER: "anthropic",
    LLM_MODEL: params.llmModel,
    ANTHROPIC_API_KEY: params.anthropicKey,
    INTERVALS_API_KEY: "test-mock-key",
    INTERVALS_ATHLETE_ID: S8A_ATHLETE_ID,
    COACH_TZ: "UTC",
    TZ: "UTC",
    ...params.scenarioEnv,
  };
  for (const key of SCRUBBED_ENV_KNOBS) {
    delete env[key];
  }
  if (params.scenarioEnv?.HISTORY_TOKEN_BUDGET_RATIO === undefined) {
    delete env.HISTORY_TOKEN_BUDGET_RATIO;
  }

  const result = spawnSync(join(REPO_ROOT, "node_modules", ".bin", "tsx"), childArgs, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdoutLines = (result.stdout ?? "").split("\n").filter((l) => l.trim() !== "");
  let verdict: ScenarioVerdict | null = null;
  for (let i = stdoutLines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(stdoutLines[i]) as ScenarioVerdict;
      if (typeof parsed.scenario === "string" && typeof parsed.pass === "boolean") {
        verdict = parsed;
        break;
      }
    } catch {
      // Not the verdict line; keep scanning upward.
    }
  }
  return { verdict, exitCode: result.status ?? 2, stderr: result.stderr ?? "" };
}

function gitSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function readRecordingModel(fixtureDir: string): string {
  const path = join(fixtureDir, "recording.json");
  if (!existsSync(path)) return RECORD_MODEL_DEFAULT;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { model?: string };
    return parsed.model ?? RECORD_MODEL_DEFAULT;
  } catch {
    return RECORD_MODEL_DEFAULT;
  }
}

async function loadScenarioEnv(entry: ManifestEntry): Promise<Record<string, string> | undefined> {
  const mod = (await import(`./scenarios/${entry.module}.js`)) as { scenario: S8aScenario };
  const env = mod.scenario.env;
  if (env?.HISTORY_TOKEN_BUDGET_RATIO === undefined) return undefined;
  // ONLY this key is honored.
  return { HISTORY_TOKEN_BUDGET_RATIO: env.HISTORY_TOKEN_BUDGET_RATIO };
}

function printTable(verdicts: ScenarioVerdict[]): void {
  for (const v of verdicts) {
    const status = !v.pass ? "FAIL" : (v.warns?.length ?? 0) > 0 ? "WARN" : "PASS";
    console.log(`${status}  ${v.scenario}`);
    for (const w of v.warns ?? []) console.log(`      WARN ${w.assertId}: ${w.detail}`);
    for (const f of v.failures) {
      console.log(`      FAIL ${f.assertId}: ${f.detail}${f.diffFile !== undefined ? ` (${f.diffFile})` : ""}`);
    }
  }
}

async function replayScenarios(params: {
  entries: ManifestEntry[];
  runDir: string;
  noSupersessions?: boolean;
}): Promise<{ verdicts: ScenarioVerdict[]; harnessError: boolean }> {
  const verdicts: ScenarioVerdict[] = [];
  let harnessError = false;
  for (const entry of params.entries) {
    const fixtureDir = join(HERE, "fixtures", entry.id);
    const outcome = spawnScenarioChild({
      scenarioId: entry.id,
      mode: "replay",
      runDir: join(params.runDir, entry.id),
      noSupersessions: params.noSupersessions,
      scenarioEnv: await loadScenarioEnv(entry),
      llmModel: readRecordingModel(fixtureDir),
      anthropicKey: REPLAY_DUMMY_KEY,
    });
    if (outcome.verdict === null || outcome.exitCode === 2) {
      console.error(`harness error in scenario ${entry.id} (exit ${outcome.exitCode}):\n${outcome.stderr}`);
      harnessError = true;
      if (outcome.verdict !== null) verdicts.push(outcome.verdict);
      continue;
    }
    verdicts.push(outcome.verdict);
  }
  return { verdicts, harnessError };
}

async function main(): Promise<void> {
  const flags = parseRunFlags(process.argv.slice(2));
  if (flags.kind === "usage-error") {
    console.error(flags.message);
    console.error(usage());
    process.exit(2);
  }

  const preflight = distPreflight(REPO_ROOT);
  if (preflight !== null) {
    console.error(preflight);
    process.exit(2);
  }

  const runInstant = new Date();
  const runDir = join(REPO_ROOT, ".tests", "runs", runDirName(runInstant));
  mkdirSync(runDir, { recursive: true });
  console.log(`run dir: ${runDir}`);

  const writeHeader = (scenarios: string[], verdicts: ScenarioVerdict[]) => {
    const header = buildHeader({
      ts: runInstant.toISOString(),
      gitSha: gitSha(),
      scenarios,
      verdicts,
    });
    writeFileSync(join(runDir, "header.json"), JSON.stringify(header, null, 2) + "\n", "utf-8");
  };

  if (flags.kind === "record") {
    if (process.env.INTERVALS_API_KEY !== undefined && process.env.INTERVALS_API_KEY !== "test-mock-key") {
      console.error("record refuses against a possibly-real intervals key (unset INTERVALS_API_KEY or set the test-mock-key sentinel)");
      process.exit(2);
    }
    const realKey = process.env.ANTHROPIC_API_KEY;
    if (realKey === undefined || realKey === "") {
      console.error("record requires a real ANTHROPIC_API_KEY in env");
      process.exit(2);
    }
    const entry = SCENARIO_MANIFEST.find((e) => e.id === flags.scenario);
    if (entry === undefined) {
      console.error(`unknown scenario: ${flags.scenario}`);
      process.exit(2);
    }
    const outcome = spawnScenarioChild({
      scenarioId: entry.id,
      mode: "record",
      runDir: join(runDir, entry.id),
      scenarioEnv: await loadScenarioEnv(entry),
      llmModel: process.env.LLM_MODEL ?? RECORD_MODEL_DEFAULT,
      anthropicKey: realKey,
    });
    process.stderr.write(outcome.stderr);
    if (outcome.exitCode !== 0) {
      console.error(`record failed for ${entry.id} (exit ${outcome.exitCode})`);
      process.exit(2);
    }
    console.log(`recorded ${entry.id}`);
    writeHeader([entry.id], outcome.verdict !== null ? [outcome.verdict] : []);
    process.exit(0);
  }

  if (flags.kind === "self-test") {
    // Probe (a): drift inversion. Every self-test child runs --no-supersessions
    // so no registry entry can ever downgrade a seeded failure to WARN.
    const driftOutcome = spawnScenarioChild({
      scenarioId: "turn-basic-wellness",
      mode: "replay",
      runDir: join(runDir, "drift-must-fail"),
      fixtureDir: join(HERE, "fixtures", "drift-must-fail"),
      noSupersessions: true,
      llmModel: readRecordingModel(join(HERE, "fixtures", "drift-must-fail")),
      anthropicKey: REPLAY_DUMMY_KEY,
    });
    if (driftOutcome.verdict === null || driftOutcome.exitCode === 2) {
      console.error(`drift probe harness error (exit ${driftOutcome.exitCode}):\n${driftOutcome.stderr}`);
      process.exit(2);
    }
    const failures = driftOutcome.verdict.failures;
    const hashDetected = failures.some((f) => f.assertId === "A1" || f.assertId === "A3");
    const toolDetected = failures.some((f) => f.assertId === "A2");
    const driftPass = hashDetected && toolDetected;
    console.log(
      `drift probe: ${driftPass ? "PASS" : "FAIL"} — seeded system-prompt mutation ${hashDetected ? "detected (A1/A3)" : "NOT detected"}; seeded tool-input mutation ${toolDetected ? "detected (A2)" : "NOT detected"}`,
    );

    // Probe (b): determinism — two fresh children, byte-compare the snapshotted
    // home trees. The byte-compare is the pass criterion, NOT the exit codes.
    const probeDirs = ["turn-basic-wellness-probe1", "turn-basic-wellness-probe2"].map((d) => join(runDir, d));
    for (const dir of probeDirs) {
      spawnScenarioChild({
        scenarioId: "turn-basic-wellness",
        mode: "replay",
        runDir: dir,
        noSupersessions: true,
        llmModel: readRecordingModel(join(HERE, "fixtures", "turn-basic-wellness")),
        anthropicKey: REPLAY_DUMMY_KEY,
      });
    }
    const diff = spawnSync("diff", ["-r", join(probeDirs[0], "home"), join(probeDirs[1], "home")], {
      encoding: "utf-8",
    });
    const deterministic = diff.status === 0;
    console.log(
      deterministic
        ? "determinism probe: PASS — two replay home trees byte-identical"
        : `determinism probe: FAIL — trees differ:\n${diff.stdout}`,
    );

    process.exit(driftPass && deterministic ? 0 : 1);
  }

  if (flags.kind === "rebaseline") {
    const entries = selectScenarios(SCENARIO_MANIFEST, {});
    const { verdicts, harnessError } = await replayScenarios({ entries, runDir });
    printTable(verdicts);
    writeHeader(entries.map((e) => e.id), verdicts);
    if (harnessError) process.exit(2);
    const gate = canRebaseline(verdicts);
    if (!gate.ok) {
      console.error(`rebaseline refused: ${gate.reason}`);
      process.exit(1);
    }
    for (const entry of entries) {
      rebaselineFixture({
        fixtureDir: join(HERE, "fixtures", entry.id),
        snapshotHomeDir: join(runDir, entry.id, "home"),
        liveTemplateHash: lastTemplateHash(join(runDir, entry.id, "home")),
      });
      console.log(`rebaselined ${entry.id}`);
    }
    process.exit(0);
  }

  // replay-all | replay-one | live
  const entries =
    flags.kind === "live"
      ? selectScenarios(SCENARIO_MANIFEST, { tier: "live", scenario: flags.scenario })
      : selectScenarios(SCENARIO_MANIFEST, {
          scenario: flags.kind === "replay-one" ? flags.scenario : undefined,
        });
  if (entries.length === 0) {
    console.error("no matching scenarios");
    process.exit(2);
  }
  const { verdicts, harnessError } = await replayScenarios({ entries, runDir });
  printTable(verdicts);
  writeHeader(entries.map((e) => e.id), verdicts);
  if (harnessError) process.exit(2);
  process.exit(aggregateExitCode(verdicts));
}

function lastTemplateHash(snapshotHomeDir: string): string | null {
  const all = [...collectSessionLineage(snapshotHomeDir).values()].flat();
  return all.at(-1)?.templateHash ?? null;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(2);
  });
}
