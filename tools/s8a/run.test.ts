import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  aggregateExitCode,
  buildChildEnv,
  buildHeader,
  classifyReplayOutcome,
  distPreflight,
  parseRecordingLane,
  parseLastScenarioChildStage,
  parseRunFlags,
  resolveRecordLane,
  runDirName,
  runSelfTestDeterminism,
  safeScenarioDiagnosticId,
  spawnScenarioChild,
  spawnScenarioProcess,
  type ScenarioChildCaptureDependencies,
  type ScenarioChildProcess,
  type ScenarioChildSpawn,
  type ScenarioChildSpawnOptions,
  usage,
} from "./run.js";
import { AUTH_PROFILES_SOURCE_ENV } from "./lib/codex-auth.js";
import type { ScenarioVerdict } from "./lib/types.js";

const RUN_SCENARIO_SOURCE = readFileSync(new URL("./run-scenario.ts", import.meta.url), "utf-8");
const RUN_SOURCE = readFileSync(new URL("./run.ts", import.meta.url), "utf-8");
const CAPTURE_NATIVE_EXIT_URL = new URL("./capture-native-exit.mjs", import.meta.url).href;

describe("scenario child stage diagnostics", () => {
  it("returns only the last exact allowlisted marker for the expected scenario", () => {
    const output = [
      "S8A_CHILD_STAGE START scenario=inj-02 stage=setup elapsed-ms=0",
      "S8A_CHILD_STAGE DONE scenario=inj-02 stage=setup elapsed-ms=7",
      "S8A_CHILD_STAGE START scenario=inj-03 stage=cleanup elapsed-ms=8",
      "S8A_CHILD_STAGE START scenario=inj-02 stage=turn turn=0 elapsed-ms=11",
      "S8A_CHILD_STAGE START scenario=inj-02 stage=private elapsed-ms=12",
    ].join("\n");
    expect(parseLastScenarioChildStage(output, "inj-02")).toEqual({
      stage: "turn-0-start",
      elapsedMs: 11,
    });
    expect(parseLastScenarioChildStage(output, "unsafe/path")).toEqual({
      stage: "none",
      elapsedMs: null,
    });
  });

  it("rejects malformed, mismatched, and structurally invalid markers", () => {
    expect(
      parseLastScenarioChildStage("S8A_CHILD_STAGE START scenario=inj-02 stage=turn", "inj-02"),
    ).toEqual({ stage: "none", elapsedMs: null });
    expect(
      parseLastScenarioChildStage(
        "S8A_CHILD_STAGE DONE scenario=inj-02 stage=setup turn=0 elapsed-ms=2",
        "inj-02",
      ),
    ).toEqual({ stage: "none", elapsedMs: null });
    expect(
      parseLastScenarioChildStage(
        "prefix S8A_CHILD_STAGE START scenario=inj-02 stage=setup elapsed-ms=2",
        "inj-02",
      ),
    ).toEqual({ stage: "none", elapsedMs: null });
    expect(
      parseLastScenarioChildStage(
        "S8A_CHILD_STAGE START scenario=inj-03 stage=setup elapsed-ms=2",
        "inj-02",
      ),
    ).toEqual({ stage: "none", elapsedMs: null });
    expect(
      parseLastScenarioChildStage(
        "S8A_CHILD_STAGE START scenario=inj-02 stage=turn turn=123456789 elapsed-ms=2",
        "inj-02",
      ),
    ).toEqual({ stage: "none", elapsedMs: null });
  });

  it.each(["-1", "1.5", "0000001", "12345678"])(
    "rejects unsafe elapsed value %s",
    (elapsedMs) => {
      expect(
        parseLastScenarioChildStage(
          `S8A_CHILD_STAGE DONE scenario=inj-02 stage=cleanup elapsed-ms=${elapsedMs}`,
          "inj-02",
        ),
      ).toEqual({ stage: "none", elapsedMs: null });
    },
  );

  it("keeps the synchronous exit-intent boundary", () => {
    const output = [
      "S8A_CHILD_STAGE DONE scenario=inj-02 stage=cleanup elapsed-ms=119001",
      "S8A_CHILD_STAGE DONE scenario=inj-02 stage=exit-intent elapsed-ms=119002",
    ].join("\n");
    expect(parseLastScenarioChildStage(output.split("\n")[0], "inj-02")).toEqual({
      stage: "cleanup-done",
      elapsedMs: 119001,
    });
    expect(parseLastScenarioChildStage(output, "inj-02")).toEqual({
      stage: "exit-intent-done",
      elapsedMs: 119002,
    });
  });

  it.each(["i12345678", "12345678", "foo-i12345678-bar", "foo-12345678-bar"])(
    "keeps fixture-private scenario id %s out of diagnostics",
    async (privateId) => {
      expect(safeScenarioDiagnosticId(privateId)).toBe("unknown");
      expect(
        parseLastScenarioChildStage(
          `S8A_CHILD_STAGE START scenario=${privateId} stage=setup elapsed-ms=1`,
          privateId,
        ),
      ).toEqual({ stage: "none", elapsedMs: null });

      const spawnProcess = vi.fn<ScenarioChildSpawn>(async (_command, _args, options) => {
        const home = options.env.CYCLING_COACH_HOME;
        if (home !== undefined) rmSync(home, { recursive: true, force: true });
        return {
          stdout: "S8A_CHILD_STAGE START scenario=unknown stage=setup elapsed-ms=1\n",
          stderr: privateId,
          status: null,
          error: Object.assign(new Error(privateId), { code: "ETIMEDOUT" }),
        };
      });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const outcome = await spawnScenarioChild(
        {
          scenarioId: privateId,
          stage: "replay",
          mode: "replay",
          runDir: "/fixed/run",
          provider: "openai-codex",
          llmModel: "gpt-5.6-sol",
        },
        spawnProcess,
      );
      const surfaced = JSON.stringify({ outcome, logs: log.mock.calls });
      expect(surfaced).not.toContain(privateId);
      expect(outcome.stderr).toBe(
        "scenario child timed out: scenario=unknown stage=replay child-stage=setup-start child-elapsed-ms=1",
      );
      log.mockRestore();
    },
  );

  it("binds every requested child boundary in execution order", () => {
    const markers = [
      'emitScenarioStage("START", diagnosticScenario, "setup")',
      'emitScenarioStage("DONE", diagnosticScenario, "setup")',
      'emitScenarioStage("START", diagnosticScenario, "turn", turnIndex)',
      'emitScenarioStage("DONE", diagnosticScenario, "turn", turnIndex)',
      'emitScenarioStage("START", diagnosticScenario, finishStage)',
      'emitScenarioStage("DONE", diagnosticScenario, finishStage)',
      'emitScenarioStage("START", diagnosticScenario, "cleanup")',
      'emitScenarioStage("DONE", diagnosticScenario, "cleanup")',
      'emitSynchronousScenarioStage(diagnosticScenario, "exit-intent")',
      "  restoreCapturedNativeExit();",
      "process.exit(exitCode)",
    ];
    const positions = markers.map((marker) => RUN_SCENARIO_SOURCE.indexOf(marker));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
    expect(RUN_SCENARIO_SOURCE).toContain("/[0-9]{8,}/");
    expect(RUN_SCENARIO_SOURCE).toContain("process.hrtime.bigint()");
    expect(RUN_SCENARIO_SOURCE).toContain(
      'writeSync(process.stdout.fd, `${formatScenarioStage("DONE", scenarioId, stage)}\\n`)',
    );
    expect(RUN_SCENARIO_SOURCE).not.toContain("installExitPathProbes");
    expect(RUN_SCENARIO_SOURCE).toContain(
      'Symbol.for("enduragent.s8a.nativeReallyExit")',
    );
    expect(RUN_SCENARIO_SOURCE).toContain(
      'harnessError("native exit capture is unavailable")',
    );
    expect(RUN_SCENARIO_SOURCE).toContain(
      "Object.getOwnPropertyDescriptor(globalThis, NATIVE_REALLY_EXIT_KEY)",
    );
    expect(RUN_SCENARIO_SOURCE).not.toContain("rawListeners");
    expect(RUN_SCENARIO_SOURCE).not.toContain("getEventListeners");
    expect(RUN_SCENARIO_SOURCE).not.toContain(".listeners(");
    expect(RUN_SCENARIO_SOURCE).not.toContain(".toString(");
  });

  it("awaits every real scenario-child lane without synchronous scenario spawning", () => {
    const spawnProcessSource = RUN_SOURCE.slice(
      RUN_SOURCE.indexOf("export async function spawnScenarioProcess("),
      RUN_SOURCE.indexOf("export interface ChildEnvParams"),
    );
    expect(spawnProcessSource).not.toContain("spawnSync");
    expect(RUN_SOURCE).toContain("export async function spawnScenarioProcess(");
    expect(RUN_SOURCE).toContain("export async function spawnScenarioChild(");
    expect(RUN_SOURCE).toContain("export async function runSelfTestDeterminism(");
    expect(RUN_SOURCE.match(/await spawnScenarioChild\(/g)).toHaveLength(4);
    expect(RUN_SOURCE).toContain("const determinism = await runSelfTestDeterminism({");
  });
});

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
    NODE_OPTIONS: "--import=/private/operator-hook.mjs",
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
    expect(env.NODE_OPTIONS).toBeUndefined();
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

describe("scenario child process", () => {
  afterEach(() => vi.restoreAllMocks());

  const params = {
    scenarioId: "turn-basic-wellness",
    stage: "replay" as const,
    mode: "replay" as const,
    runDir: "/fixed/run",
    provider: "openai-codex" as const,
    llmModel: "gpt-5.6-sol",
  };

  function removeTempHome(options: Parameters<ScenarioChildSpawn>[2]): void {
    const home = options.env.CYCLING_COACH_HOME;
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
  }

  it("applies the fixed deadline and preserves a normal verdict", async () => {
    const verdict: ScenarioVerdict = {
      scenario: "turn-basic-wellness",
      pass: false,
      failures: [{ assertId: "A1", scenario: "turn-basic-wellness", detail: "drift" }],
    };
    const spawnProcess = vi.fn<ScenarioChildSpawn>(async (_command, _args, options) => {
      removeTempHome(options);
      return { stdout: `${JSON.stringify(verdict)}\n`, stderr: "fixed stderr", status: 1 };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const outcome = await spawnScenarioChild(params, spawnProcess);

    expect(outcome).toEqual({ verdict, exitCode: 1, stderr: "fixed stderr" });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[1]).toEqual([
      "--import",
      CAPTURE_NATIVE_EXIT_URL,
      "--import",
      "tsx",
      fileURLToPath(new URL("./run-scenario.ts", import.meta.url)),
      "--scenario=turn-basic-wellness",
      "--mode=replay",
      "--run-dir=/fixed/run",
    ]);
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "S8A_CHILD START scenario=turn-basic-wellness stage=replay",
      "S8A_CHILD DONE scenario=turn-basic-wellness stage=replay outcome=exit-1",
    ]);
  });

  it("maps ETIMEDOUT to a stable path-free harness error", async () => {
    const spawnProcess = vi.fn<ScenarioChildSpawn>(async (_command, _args, options) => {
      removeTempHome(options);
      return {
        stdout:
          "S8A_CHILD_STAGE START scenario=unknown stage=turn turn=3 elapsed-ms=119000\n/private/athlete-home/token\n",
        stderr: "/private/athlete-home/token",
        status: null,
        error: Object.assign(new Error("/private/athlete-home/token"), { code: "ETIMEDOUT" }),
      };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const outcome = await spawnScenarioChild(
      { ...params, scenarioId: "../../private/athlete-home" },
      spawnProcess,
    );

    expect(outcome).toEqual({
      verdict: null,
      exitCode: 2,
      stderr:
        "scenario child timed out: scenario=unknown stage=replay child-stage=turn-3-start child-elapsed-ms=119000",
    });
    expect(JSON.stringify(outcome)).not.toContain("private/athlete-home");
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "S8A_CHILD START scenario=unknown stage=replay",
      "S8A_CHILD DONE scenario=unknown stage=replay outcome=timeout",
    ]);
  });

  it("stops determinism before the second child and diff after a timeout", async () => {
    const spawnProcess = vi.fn<ScenarioChildSpawn>(async (_command, _args, options) => {
      removeTempHome(options);
      return {
        stdout: null,
        stderr: null,
        status: null,
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      };
    });
    const diffProcess = vi.fn(() => ({ status: 0, stdout: "" }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const outcome = await runSelfTestDeterminism(
      {
        probeDirs: ["/fixed/probe-1", "/fixed/probe-2"],
        provider: "openai-codex",
        llmModel: "gpt-5.6-sol",
      },
      spawnProcess,
      diffProcess,
    );

    expect(outcome).toMatchObject({ kind: "harness-error", outcome: { exitCode: 2 } });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(diffProcess).not.toHaveBeenCalled();
  });

  it("runs both determinism children before the diff", async () => {
    const verdict: ScenarioVerdict = {
      scenario: "turn-basic-wellness",
      pass: true,
      failures: [],
    };
    const spawnProcess = vi.fn<ScenarioChildSpawn>(async (_command, _args, options) => {
      removeTempHome(options);
      return { stdout: `${JSON.stringify(verdict)}\n`, stderr: "", status: 0 };
    });
    const diffProcess = vi.fn(() => ({ status: 0, stdout: "" }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const outcome = await runSelfTestDeterminism(
      {
        probeDirs: ["/fixed/probe-1", "/fixed/probe-2"],
        provider: "openai-codex",
        llmModel: "gpt-5.6-sol",
      },
      spawnProcess,
      diffProcess,
    );

    expect(outcome).toEqual({ kind: "complete", deterministic: true, diffOutput: "" });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(diffProcess).toHaveBeenCalledOnce();
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "S8A_CHILD START scenario=turn-basic-wellness stage=self-test-determinism-1",
      "S8A_CHILD DONE scenario=turn-basic-wellness stage=self-test-determinism-1 outcome=exit-0",
      "S8A_CHILD START scenario=turn-basic-wellness stage=self-test-determinism-2",
      "S8A_CHILD DONE scenario=turn-basic-wellness stage=self-test-determinism-2 outcome=exit-0",
    ]);
  });
});

describe("native exit capture", () => {
  let fixtureDir: string;

  afterEach(() => rmSync(fixtureDir, { recursive: true, force: true }));

  it("runs ordinary and signal-exit hooks while bypassing a late reallyExit wrapper", () => {
    fixtureDir = mkdtempSync(join(tmpdir(), "s8a-native-exit-test-"));
    const fixturePath = join(fixtureDir, "fixture.mjs");
    const signalExitUrl = pathToFileURL(
      fileURLToPath(
        new URL(
          "../../node_modules/.pnpm/signal-exit@4.1.0/node_modules/signal-exit/dist/mjs/index.js",
          import.meta.url,
        ),
      ),
    ).href;
    writeFileSync(
      fixturePath,
      [
        'import { writeSync } from "node:fs";',
        `import { onExit } from ${JSON.stringify(signalExitUrl)};`,
        'const key = Symbol.for("enduragent.s8a.nativeReallyExit");',
        'process.on("exit", (code) => writeSync(process.stdout.fd, `ordinary:${code}\\n`));',
        'onExit((code) => writeSync(process.stdout.fd, `signal-exit:${code}\\n`));',
        'process.reallyExit = () => writeSync(process.stdout.fd, "late-wrapper\\n");',
        'const captured = globalThis[key];',
        'if (typeof captured !== "function") process.exit(2);',
        'process.reallyExit = captured;',
        'process.exit(7);',
      ].join("\n"),
      "utf-8",
    );

    const result = spawnSync(process.execPath, ["--import", CAPTURE_NATIVE_EXIT_URL, fixturePath], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(7);
    expect(result.stdout).toBe("ordinary:7\nsignal-exit:7\n");
    expect(result.stdout).not.toContain("late-wrapper");
    expect(result.stderr).toBe("");
  });

  it.each([
    ["missing native exit", 'process.reallyExit = undefined;'],
    [
      "duplicate capture",
      'Object.defineProperty(globalThis, Symbol.for("enduragent.s8a.nativeReallyExit"), { value: () => {}, configurable: false });',
    ],
  ])("fails path-free when capture starts with %s", (_label, setup) => {
    fixtureDir = mkdtempSync(join(tmpdir(), "s8a-native-exit-test-"));
    const setupUrl = `data:text/javascript,${encodeURIComponent(setup)}`;
    const result = spawnSync(
      process.execPath,
      ["--import", setupUrl, "--import", CAPTURE_NATIVE_EXIT_URL, "--eval", ""],
      { encoding: "utf-8" },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("s8a native exit capture failed\n");
    expect(`${result.stdout}${result.stderr}`).not.toContain(fixtureDir);
  });
});

describe("scenario child file capture", () => {
  let captureParent: string;
  type CaptureSpawn = NonNullable<ScenarioChildCaptureDependencies["spawnProcess"]>;

  afterEach(() => rmSync(captureParent, { recursive: true, force: true }));

  const options: ScenarioChildSpawnOptions = {
    cwd: "/fixed/repo",
    env: { FIXED: "value" },
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    killSignal: "SIGKILL",
  };

  function makeCaptureParent(): void {
    captureParent = mkdtempSync(join(tmpdir(), "s8a-capture-test-"));
  }

  function emittedChild(
    outcome: { status: number | null } | { error: Error & { code?: string } },
    kill = vi.fn(() => true),
  ): ScenarioChildProcess {
    const events = new EventEmitter();
    const child = Object.assign(events, { kill }) as unknown as ScenarioChildProcess;
    queueMicrotask(() => {
      if ("error" in outcome) events.emit("error", outcome.error);
      else events.emit("exit", outcome.status);
    });
    return child;
  }

  it.each([0, 1] as const)(
    "passes file descriptors through direct exit %i and removes the files",
    async (status) => {
      makeCaptureParent();
      const spawnProcess = vi.fn<CaptureSpawn>((_command, _args, spawnOptions) => {
        expect(spawnOptions.stdio[0]).toBe("ignore");
        expect(spawnOptions.stdio[1]).toEqual(expect.any(Number));
        expect(spawnOptions.stdio[2]).toEqual(expect.any(Number));
        writeFileSync(spawnOptions.stdio[1], "fixed stdout", "utf-8");
        writeFileSync(spawnOptions.stdio[2], "fixed stderr", "utf-8");
        return emittedChild({ status });
      });

      const result = await spawnScenarioProcess("node", ["child.js"], options, {
        captureParent,
        spawnProcess,
      });

      expect(result).toEqual({ stdout: "fixed stdout", stderr: "fixed stderr", status });
      expect(spawnProcess).toHaveBeenCalledOnce();
      expect(readdirSync(captureParent)).toEqual([]);
    },
  );

  it("preserves a spawn failure code with path-free output and removes the files", async () => {
    makeCaptureParent();
    const result = await spawnScenarioProcess("node", ["child.js"], options, {
      captureParent,
      spawnProcess: (_command, _args, spawnOptions) => {
        writeFileSync(spawnOptions.stdio[1], "fixed stage", "utf-8");
        return emittedChild({
          error: Object.assign(new Error("/private/athlete-home/token"), { code: "ENOENT" }),
        });
      },
    });

    expect(result).toMatchObject({
      stdout: "fixed stage",
      stderr: "",
      status: null,
      error: { message: "scenario child process failed", code: "ENOENT" },
    });
    expect(JSON.stringify(result)).not.toContain("private/athlete-home");
    expect(readdirSync(captureParent)).toEqual([]);
  });

  it("kills once and returns ETIMEDOUT at the fixed deadline", async () => {
    makeCaptureParent();
    vi.useFakeTimers();
    const events = new EventEmitter();
    const kill = vi.fn(() => true);
    const child = Object.assign(events, { kill }) as unknown as ScenarioChildProcess;
    try {
      const resultPromise = spawnScenarioProcess("node", ["child.js"], options, {
        captureParent,
        spawnProcess: () => child,
      });
      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(120_000);
      events.emit(
        "error",
        Object.assign(new Error("/private/athlete-home/token"), { code: "EIO" }),
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(readdirSync(captureParent)).toHaveLength(1);
      events.emit("exit", null);
      const result = await resultPromise;

      expect(kill).toHaveBeenCalledOnce();
      expect(kill).toHaveBeenCalledWith("SIGKILL");
      expect(result).toMatchObject({
        status: null,
        error: { message: "scenario child process failed", code: "ETIMEDOUT" },
      });
      expect(JSON.stringify(result)).not.toContain("private/athlete-home");
      expect(readdirSync(captureParent)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized output without reading or retaining it", async () => {
    makeCaptureParent();
    const result = await spawnScenarioProcess("node", ["child.js"], { ...options, maxBuffer: 4 }, {
      captureParent,
      spawnProcess: (_command, _args, spawnOptions) => {
        writeFileSync(spawnOptions.stdio[1], "12345", "utf-8");
        return emittedChild({ status: 0 });
      },
    });

    expect(result).toMatchObject({
      stdout: null,
      stderr: null,
      status: null,
      error: { message: "scenario child output exceeded limit", code: "ENOBUFS" },
    });
    expect(readdirSync(captureParent)).toEqual([]);
  });

  it("returns after the direct child exits while its descendant still holds stdio", async () => {
    makeCaptureParent();
    let descendantPid: number | undefined;
    const descendantScript =
      'setTimeout(() => process.stdout.write("descendant-finished"), 30000)';
    const script = [
      'const { spawn } = require("node:child_process")',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: ["ignore", 1, 2] })`,
      'process.stdout.write(`direct-complete:${child.pid}\\n`)',
      "process.exit(0)",
    ].join(";");

    try {
      const result = await spawnScenarioProcess(
        process.execPath,
        ["-e", script],
        { ...options, cwd: captureParent, env: process.env },
        { captureParent },
      );
      const pidMatch = /^direct-complete:([0-9]+)\n$/.exec(result.stdout ?? "");
      descendantPid = pidMatch === null ? undefined : Number.parseInt(pidMatch[1], 10);

      expect(result.status).toBe(0);
      expect(result.error).toBeUndefined();
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(result.stdout).not.toContain("descendant-finished");
      expect(readdirSync(captureParent)).toEqual([]);
    } finally {
      if (descendantPid !== undefined) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
    }
  });
});

describe("replay harness errors", () => {
  it("stops after a missing verdict or harness exit", () => {
    expect(classifyReplayOutcome({ verdict: null, exitCode: 2, stderr: "timeout" })).toEqual({
      kind: "harness-error",
      verdict: null,
    });
    expect(
      classifyReplayOutcome({
        verdict: { scenario: "a", pass: false, failures: [] },
        exitCode: 2,
        stderr: "harness error",
      }),
    ).toEqual({
      kind: "harness-error",
      verdict: { scenario: "a", pass: false, failures: [] },
    });
  });

  it("continues after a normal pass or assertion failure", () => {
    expect(
      classifyReplayOutcome({
        verdict: { scenario: "a", pass: true, failures: [] },
        exitCode: 0,
        stderr: "",
      }),
    ).toEqual({ kind: "verdict", verdict: { scenario: "a", pass: true, failures: [] } });
    expect(
      classifyReplayOutcome({
        verdict: { scenario: "a", pass: false, failures: [] },
        exitCode: 1,
        stderr: "",
      }),
    ).toEqual({ kind: "verdict", verdict: { scenario: "a", pass: false, failures: [] } });
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
