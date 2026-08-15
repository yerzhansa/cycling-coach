// Parent orchestrator. It spawns one fresh child process per scenario (the
// coach home env var must land before the child imports the core package, whose
// config dir is resolved at import time) and never constructs the agent itself.
// The parent's clock is never frozen: two consecutive runs always land in
// distinct run dirs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { collectSessionLineage } from "./lib/asserts.js";
import {
  AUTH_PROFILES_SOURCE_ENV,
  CODEX_PROFILE_NAME,
  ensureFreshCodexProfile,
  resolveAuthProfilesSource,
} from "./lib/codex-auth.js";
import { isS8aProvider, PROVIDER_LANES, supportedProviderList } from "./lib/provider-lane.js";
import { canRebaseline, rebaselineFixture } from "./lib/rebaseline.js";
import { S8A_ATHLETE_ID } from "./scenarios/common.js";
import { selectScenarios, type ManifestEntry } from "./lib/scenario-filter.js";
import type { S8aProvider, S8aScenario, ScenarioVerdict } from "./lib/types.js";
import { SCENARIO_MANIFEST } from "./scenarios/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const RECORD_PROVIDER_DEFAULT: S8aProvider = "openai-codex";
const LEGACY_HEADER_PROVIDER: S8aProvider = "anthropic";
const REPLAY_DUMMY_KEY = "s8a-replay-dummy";
const CAPTURE_HELPER_SHUTDOWN_GRACE_MS = 5_000;

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

export interface ChildOutcome {
  verdict: ScenarioVerdict | null;
  exitCode: number;
  stderr: string;
}

export function classifyReplayOutcome(
  outcome: ChildOutcome,
):
  | { kind: "harness-error"; verdict: ScenarioVerdict | null }
  | { kind: "verdict"; verdict: ScenarioVerdict } {
  if (outcome.verdict === null || outcome.exitCode === 2) {
    return { kind: "harness-error", verdict: outcome.verdict };
  }
  return { kind: "verdict", verdict: outcome.verdict };
}

export type ScenarioChildStage =
  | "record"
  | "replay"
  | "self-test-drift"
  | "self-test-determinism-1"
  | "self-test-determinism-2";

export interface ScenarioChildSpawnResult {
  stdout: string | null;
  stderr: string | null;
  status: number | null;
  error?: Error & { code?: string };
}

export type ScenarioChildSpawn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    encoding: "utf-8";
    maxBuffer: number;
    timeout: number;
    killSignal: "SIGKILL";
  },
) => ScenarioChildSpawnResult;

export const spawnScenarioChildCaptured: ScenarioChildSpawn = (command, args, options) => {
  const ioDir = mkdtempSync(join(tmpdir(), "s8a-child-io-"));
  const requestPath = join(ioDir, "request.json");
  const resultPath = join(ioDir, "result.json");
  const stdoutPath = join(ioDir, "stdout");
  const stderrPath = join(ioDir, "stderr");
  try {
    writeFileSync(
      requestPath,
      JSON.stringify({
        command,
        args,
        cwd: options.cwd,
        maxBuffer: options.maxBuffer,
        timeout: options.timeout,
        killSignal: options.killSignal,
      }),
      { encoding: "utf-8", mode: 0o600 },
    );
    const helper = spawnSync(
      process.execPath,
      [join(HERE, "spawn-captured.mjs"), requestPath, resultPath, stdoutPath, stderrPath],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeout + CAPTURE_HELPER_SHUTDOWN_GRACE_MS,
        killSignal: options.killSignal,
        stdio: "ignore",
      },
    );
    if (!existsSync(resultPath)) {
      return {
        stdout: null,
        stderr: null,
        status: null,
        error:
          helper.error ??
          Object.assign(new Error(`spawnSync ${command} EHELPER`), { code: "EHELPER" }),
      };
    }
    const metadata = JSON.parse(readFileSync(resultPath, "utf-8")) as {
      status: number | null;
      errorCode?: string;
      overflowStream?: "stdout" | "stderr";
    };
    const error =
      metadata.errorCode === undefined
        ? undefined
        : Object.assign(new Error(`spawnSync ${command} ${metadata.errorCode}`), {
            code: metadata.errorCode,
          });
    return {
      stdout:
        metadata.overflowStream === "stdout" ? null : readFileSync(stdoutPath, options.encoding),
      stderr:
        metadata.overflowStream === "stderr" ? null : readFileSync(stderrPath, options.encoding),
      status: metadata.status,
      error,
    };
  } finally {
    rmSync(ioDir, { recursive: true, force: true });
  }
};

export function parseScenarioChildExit(output: string): 0 | 1 | 2 | null {
  let exitCode: 0 | 1 | 2 | null = null;
  for (const line of output.split("\n")) {
    const match = /^S8A_CHILD_EXIT code=([012])$/.exec(line.trimEnd());
    if (match !== null) exitCode = Number.parseInt(match[1], 10) as 0 | 1 | 2;
  }
  return exitCode;
}

function parseScenarioVerdict(output: string): ScenarioVerdict | null {
  const stdoutLines = output.split("\n").filter((line) => line.trim() !== "");
  for (let i = stdoutLines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(stdoutLines[i]) as ScenarioVerdict;
      if (typeof parsed.scenario === "string" && typeof parsed.pass === "boolean") return parsed;
    } catch {}
  }
  return null;
}

export interface ChildEnvParams {
  base: Record<string, string | undefined>;
  tempHome: string;
  provider: S8aProvider;
  llmModel: string;
  anthropicKey?: string;
  authProfilesSource?: string;
  scenarioEnv?: Record<string, string>;
}

export function buildChildEnv(params: ChildEnvParams): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...params.base,
    CYCLING_COACH_HOME: params.tempHome,
    LLM_PROVIDER: params.provider,
    LLM_MODEL: params.llmModel,
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
  if (params.anthropicKey === undefined) delete env.ANTHROPIC_API_KEY;
  else env.ANTHROPIC_API_KEY = params.anthropicKey;
  if (params.authProfilesSource === undefined) delete env[AUTH_PROFILES_SOURCE_ENV];
  else env[AUTH_PROFILES_SOURCE_ENV] = params.authProfilesSource;
  return env;
}

export function spawnScenarioChild(
  params: {
    scenarioId: string;
    stage: ScenarioChildStage;
    mode: "replay" | "record";
    runDir: string;
    fixtureDir?: string;
    noSupersessions?: boolean;
    scenarioEnv?: Record<string, string>;
    provider: S8aProvider;
    llmModel: string;
    anthropicKey?: string;
    authProfilesSource?: string;
  },
  spawnProcess: ScenarioChildSpawn = spawnScenarioChildCaptured,
): ChildOutcome {
  const safeScenarioId = safeScenarioDiagnosticId(params.scenarioId);
  console.log(`S8A_CHILD START scenario=${safeScenarioId} stage=${params.stage}`);
  const tempHome = mkdtempSync(join(tmpdir(), "s8a-home-"));
  const childArgs = [
    join(HERE, "run-scenario.ts"),
    `--scenario=${params.scenarioId}`,
    `--mode=${params.mode}`,
    `--run-dir=${params.runDir}`,
    ...(params.fixtureDir !== undefined ? [`--fixture-dir=${params.fixtureDir}`] : []),
    ...(params.noSupersessions === true ? ["--no-supersessions"] : []),
  ];
  const env = buildChildEnv({
    base: process.env,
    tempHome,
    provider: params.provider,
    llmModel: params.llmModel,
    anthropicKey: params.anthropicKey,
    authProfilesSource: params.authProfilesSource,
    scenarioEnv: params.scenarioEnv,
  });

  const result = spawnProcess(process.execPath, ["--import", "tsx", ...childArgs], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: params.mode === "replay" ? 15_000 : 120_000,
    killSignal: "SIGKILL",
  });
  const stdout = result.stdout ?? "";
  const verdict = parseScenarioVerdict(stdout);
  if (result.error?.code === "ETIMEDOUT") {
    const childStage = parseLastScenarioChildStage(stdout, safeScenarioId);
    const logicalExitCode = parseScenarioChildExit(stdout);
    if (
      childStage === "cleanup-done" &&
      logicalExitCode !== null &&
      (logicalExitCode === 2 || verdict !== null)
    ) {
      console.log(
        `S8A_CHILD DONE scenario=${safeScenarioId} stage=${params.stage} outcome=recovered-exit-${logicalExitCode}`,
      );
      return { verdict, exitCode: logicalExitCode, stderr: result.stderr ?? "" };
    }
    console.log(`S8A_CHILD DONE scenario=${safeScenarioId} stage=${params.stage} outcome=timeout`);
    return {
      verdict: null,
      exitCode: 2,
      stderr: `scenario child timed out: scenario=${safeScenarioId} stage=${params.stage} child-stage=${childStage}`,
    };
  }
  const exitCode = result.status ?? 2;
  console.log(`S8A_CHILD DONE scenario=${safeScenarioId} stage=${params.stage} outcome=exit-${exitCode}`);
  return { verdict, exitCode, stderr: result.stderr ?? "" };
}

export function parseLastScenarioChildStage(output: string, scenarioId: string): string {
  const maxDiagnosticTurnIndex = 99;
  const safeScenarioId = safeScenarioDiagnosticId(scenarioId);
  let last = "none";
  for (const line of output.split("\n")) {
    const match =
      /^S8A_CHILD_STAGE (START|DONE) scenario=([a-z0-9]+(?:-[a-z0-9]+)*) stage=(setup|turn|finish-replay|finish-record|cleanup)(?: turn=(0|[1-9][0-9]*))?$/.exec(
        line.trimEnd(),
      );
    if (match === null || match[2] !== safeScenarioId) continue;
    const phase = match[1].toLowerCase();
    const stage = match[3];
    const turn = match[4];
    if ((stage === "turn") !== (turn !== undefined)) continue;
    if (turn !== undefined && Number.parseInt(turn, 10) > maxDiagnosticTurnIndex) continue;
    last = stage === "turn" ? `turn-${turn}-${phase}` : `${stage}-${phase}`;
  }
  return last;
}

export function safeScenarioDiagnosticId(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return "unknown";
  if (/[0-9]{8,}/.test(value)) return "unknown";
  return value;
}

export type SelfTestDiffSpawn = (
  command: string,
  args: readonly string[],
  options: { encoding: "utf-8" },
) => { status: number | null; stdout: string | null };

export function runSelfTestDeterminism(
  params: {
    probeDirs: readonly [string, string];
    provider: S8aProvider;
    llmModel: string;
    anthropicKey?: string;
  },
  spawnProcess: ScenarioChildSpawn = spawnScenarioChildCaptured,
  diffProcess: SelfTestDiffSpawn = (command, args, options) => spawnSync(command, args, options),
):
  | { kind: "harness-error"; outcome: ChildOutcome }
  | { kind: "complete"; deterministic: boolean; diffOutput: string } {
  const probes = [
    { dir: params.probeDirs[0], stage: "self-test-determinism-1" },
    { dir: params.probeDirs[1], stage: "self-test-determinism-2" },
  ] as const;
  for (const probe of probes) {
    const outcome = spawnScenarioChild(
      {
        scenarioId: "turn-basic-wellness",
        stage: probe.stage,
        mode: "replay",
        runDir: probe.dir,
        noSupersessions: true,
        provider: params.provider,
        llmModel: params.llmModel,
        anthropicKey: params.anthropicKey,
      },
      spawnProcess,
    );
    if (outcome.verdict === null || outcome.exitCode === 2) {
      return { kind: "harness-error", outcome };
    }
  }
  const diff = diffProcess(
    "diff",
    ["-r", join(params.probeDirs[0], "home"), join(params.probeDirs[1], "home")],
    { encoding: "utf-8" },
  );
  return {
    kind: "complete",
    deterministic: diff.status === 0,
    diffOutput: diff.stdout ?? "",
  };
}

function gitSha(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

export interface RecordingLane {
  provider: S8aProvider;
  model: string;
}

export function parseRecordingLane(raw: string | null): RecordingLane {
  const fallback: RecordingLane = {
    provider: LEGACY_HEADER_PROVIDER,
    model: PROVIDER_LANES[LEGACY_HEADER_PROVIDER].defaultRecordModel,
  };
  if (raw === null) return fallback;
  let parsed: { provider?: unknown; model?: unknown };
  try {
    parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown };
  } catch {
    return fallback;
  }
  const provider = isS8aProvider(parsed.provider) ? parsed.provider : fallback.provider;
  const model =
    typeof parsed.model === "string" && parsed.model !== ""
      ? parsed.model
      : PROVIDER_LANES[provider].defaultRecordModel;
  return { provider, model };
}

export function resolveRecordLane(
  env: Record<string, string | undefined>,
): { ok: true; lane: RecordingLane } | { ok: false; message: string } {
  const requested = env.LLM_PROVIDER ?? RECORD_PROVIDER_DEFAULT;
  if (!isS8aProvider(requested)) {
    return {
      ok: false,
      message: `LLM_PROVIDER must be one of ${supportedProviderList()}, got ${requested}`,
    };
  }
  const model = env.LLM_MODEL ?? PROVIDER_LANES[requested].defaultRecordModel;
  return { ok: true, lane: { provider: requested, model } };
}

function readRecordingLane(fixtureDir: string): RecordingLane {
  const path = join(fixtureDir, "recording.json");
  return parseRecordingLane(existsSync(path) ? readFileSync(path, "utf-8") : null);
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
    const lane = readRecordingLane(fixtureDir);
    const outcome = spawnScenarioChild({
      scenarioId: entry.id,
      stage: "replay",
      mode: "replay",
      runDir: join(params.runDir, entry.id),
      noSupersessions: params.noSupersessions,
      scenarioEnv: await loadScenarioEnv(entry),
      provider: lane.provider,
      llmModel: lane.model,
      anthropicKey: lane.provider === "anthropic" ? REPLAY_DUMMY_KEY : undefined,
    });
    const classified = classifyReplayOutcome(outcome);
    if (classified.kind === "harness-error") {
      console.error(`harness error in scenario ${entry.id} (exit ${outcome.exitCode}):\n${outcome.stderr}`);
      harnessError = true;
      if (classified.verdict !== null) verdicts.push(classified.verdict);
      break;
    }
    verdicts.push(classified.verdict);
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
    const resolved = resolveRecordLane(process.env);
    if (!resolved.ok) {
      console.error(resolved.message);
      process.exit(2);
    }
    const lane = resolved.lane;
    let anthropicKey: string | undefined;
    let authProfilesSource: string | undefined;
    if (lane.provider === "anthropic") {
      const realKey = process.env.ANTHROPIC_API_KEY;
      if (realKey === undefined || realKey === "") {
        console.error("record on the anthropic lane requires a real ANTHROPIC_API_KEY in env");
        process.exit(2);
      }
      anthropicKey = realKey;
    } else {
      const sourcePath = resolveAuthProfilesSource(process.env);
      const freshened = await ensureFreshCodexProfile({
        sourcePath,
        profileName: CODEX_PROFILE_NAME,
        nowMs: runInstant.getTime(),
      });
      if (!freshened.ok) {
        console.error(
          `record on the openai-codex lane requires a usable OAuth profile: ${freshened.reason}`,
        );
        console.error(
          `sign in through the product, or point ${AUTH_PROFILES_SOURCE_ENV} at the profiles file`,
        );
        process.exit(2);
      }
      console.log(`codex auth profile: ${freshened.state}`);
      authProfilesSource = sourcePath;
    }
    const entry = SCENARIO_MANIFEST.find((e) => e.id === flags.scenario);
    if (entry === undefined) {
      console.error(`unknown scenario: ${flags.scenario}`);
      process.exit(2);
    }
    console.log(`recording lane: ${lane.provider} / ${lane.model}`);
    const outcome = spawnScenarioChild({
      scenarioId: entry.id,
      stage: "record",
      mode: "record",
      runDir: join(runDir, entry.id),
      scenarioEnv: await loadScenarioEnv(entry),
      provider: lane.provider,
      llmModel: lane.model,
      anthropicKey,
      authProfilesSource,
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
    const driftLane = readRecordingLane(join(HERE, "fixtures", "drift-must-fail"));
    const driftOutcome = spawnScenarioChild({
      scenarioId: "turn-basic-wellness",
      stage: "self-test-drift",
      mode: "replay",
      runDir: join(runDir, "drift-must-fail"),
      fixtureDir: join(HERE, "fixtures", "drift-must-fail"),
      noSupersessions: true,
      provider: driftLane.provider,
      llmModel: driftLane.model,
      anthropicKey: driftLane.provider === "anthropic" ? REPLAY_DUMMY_KEY : undefined,
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
    const probeDirs = [
      join(runDir, "turn-basic-wellness-probe1"),
      join(runDir, "turn-basic-wellness-probe2"),
    ] as const;
    const probeLane = readRecordingLane(join(HERE, "fixtures", "turn-basic-wellness"));
    const determinism = runSelfTestDeterminism({
      probeDirs,
      provider: probeLane.provider,
      llmModel: probeLane.model,
      anthropicKey: probeLane.provider === "anthropic" ? REPLAY_DUMMY_KEY : undefined,
    });
    if (determinism.kind === "harness-error") {
      console.error(
        `determinism probe harness error (exit ${determinism.outcome.exitCode}):\n${determinism.outcome.stderr}`,
      );
      process.exit(2);
    }
    console.log(
      determinism.deterministic
        ? "determinism probe: PASS — two replay home trees byte-identical"
        : `determinism probe: FAIL — trees differ:\n${determinism.diffOutput}`,
    );

    process.exit(driftPass && determinism.deterministic ? 0 : 1);
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
