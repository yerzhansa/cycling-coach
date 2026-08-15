import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  type ScenarioChildSpawn,
  type ScenarioChildSpawnOptions,
  usage,
} from "./run.js";
import { AUTH_PROFILES_SOURCE_ENV } from "./lib/codex-auth.js";
import type { ScenarioVerdict } from "./lib/types.js";

const RUN_SCENARIO_SOURCE = readFileSync(new URL("./run-scenario.ts", import.meta.url), "utf-8");

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

  it("distinguishes each synchronous exit-path boundary", () => {
    const output = [
      "S8A_CHILD_STAGE DONE scenario=inj-02 stage=cleanup elapsed-ms=119001",
      "S8A_CHILD_STAGE DONE scenario=inj-02 stage=exit-intent elapsed-ms=119002",
      "S8A_CHILD_STAGE DONE scenario=inj-02 stage=exit-listeners elapsed-ms=119003",
      "S8A_CHILD_STAGE DONE scenario=inj-02 stage=really-exit elapsed-ms=119004",
    ].join("\n");
    expect(parseLastScenarioChildStage(output.split("\n")[0], "inj-02")).toEqual({
      stage: "cleanup-done",
      elapsedMs: 119001,
    });
    expect(parseLastScenarioChildStage(output, "inj-02")).toEqual({
      stage: "really-exit-done",
      elapsedMs: 119004,
    });
    expect(parseLastScenarioChildStage(output.split("\n").slice(0, 3).join("\n"), "inj-02")).toEqual({
      stage: "exit-listeners-done",
      elapsedMs: 119003,
    });
  });

  it.each(["i12345678", "12345678", "foo-i12345678-bar", "foo-12345678-bar"])(
    "keeps fixture-private scenario id %s out of diagnostics",
    (privateId) => {
      expect(safeScenarioDiagnosticId(privateId)).toBe("unknown");
      expect(
        parseLastScenarioChildStage(
          `S8A_CHILD_STAGE START scenario=${privateId} stage=setup elapsed-ms=1`,
          privateId,
        ),
      ).toEqual({ stage: "none", elapsedMs: null });

      const spawnProcess = vi.fn<ScenarioChildSpawn>((_command, _args, options) => {
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
      const outcome = spawnScenarioChild(
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
      "installExitPathProbes(diagnosticScenario)",
      'emitSynchronousScenarioStage(diagnosticScenario, "exit-intent")',
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
    expect(RUN_SCENARIO_SOURCE).toContain('process.on("exit", () => {');
    expect(RUN_SCENARIO_SOURCE).toContain(
      'emitSynchronousScenarioStage(scenarioId, "exit-listeners")',
    );
    expect(RUN_SCENARIO_SOURCE).toContain("const currentReallyExit = processWithReallyExit.reallyExit");
    expect(RUN_SCENARIO_SOURCE).toContain(
      'emitSynchronousScenarioStage(scenarioId, "really-exit")',
    );
    expect(RUN_SCENARIO_SOURCE).toContain(
      "return Reflect.apply(currentReallyExit, this, args) as never",
    );
    expect(RUN_SCENARIO_SOURCE).not.toContain("rawListeners");
    expect(RUN_SCENARIO_SOURCE).not.toContain("getEventListeners");
    expect(RUN_SCENARIO_SOURCE).not.toContain(".listeners(");
    expect(RUN_SCENARIO_SOURCE).not.toContain(".toString(");
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

  it("applies the fixed deadline and preserves a normal verdict", () => {
    const verdict: ScenarioVerdict = {
      scenario: "turn-basic-wellness",
      pass: false,
      failures: [{ assertId: "A1", scenario: "turn-basic-wellness", detail: "drift" }],
    };
    const spawnProcess = vi.fn<ScenarioChildSpawn>((_command, _args, options) => {
      removeTempHome(options);
      return { stdout: `${JSON.stringify(verdict)}\n`, stderr: "fixed stderr", status: 1 };
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const outcome = spawnScenarioChild(params, spawnProcess);

    expect(outcome).toEqual({ verdict, exitCode: 1, stderr: "fixed stderr" });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({
      timeout: 120_000,
      killSignal: "SIGKILL",
    });
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "S8A_CHILD START scenario=turn-basic-wellness stage=replay",
      "S8A_CHILD DONE scenario=turn-basic-wellness stage=replay outcome=exit-1",
    ]);
  });

  it("maps ETIMEDOUT to a stable path-free harness error", () => {
    const spawnProcess = vi.fn<ScenarioChildSpawn>((_command, _args, options) => {
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

    const outcome = spawnScenarioChild(
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

  it("stops determinism before the second child and diff after a timeout", () => {
    const spawnProcess = vi.fn<ScenarioChildSpawn>((_command, _args, options) => {
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

    const outcome = runSelfTestDeterminism(
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

  it("runs both determinism children before the diff", () => {
    const verdict: ScenarioVerdict = {
      scenario: "turn-basic-wellness",
      pass: true,
      failures: [],
    };
    const spawnProcess = vi.fn<ScenarioChildSpawn>((_command, _args, options) => {
      removeTempHome(options);
      return { stdout: `${JSON.stringify(verdict)}\n`, stderr: "", status: 0 };
    });
    const diffProcess = vi.fn(() => ({ status: 0, stdout: "" }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const outcome = runSelfTestDeterminism(
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

  it("passes file descriptors to the child, reads both streams, and removes the files", () => {
    makeCaptureParent();
    const spawnProcess = vi.fn<CaptureSpawn>((_command, _args, spawnOptions) => {
      expect(spawnOptions.stdio[0]).toBe("ignore");
      expect(spawnOptions.stdio[1]).toEqual(expect.any(Number));
      expect(spawnOptions.stdio[2]).toEqual(expect.any(Number));
      writeFileSync(spawnOptions.stdio[1], "fixed stdout", "utf-8");
      writeFileSync(spawnOptions.stdio[2], "fixed stderr", "utf-8");
      return { status: 0 };
    });

    const result = spawnScenarioProcess("node", ["child.js"], options, {
      captureParent,
      spawnProcess,
    });

    expect(result).toEqual({ stdout: "fixed stdout", stderr: "fixed stderr", status: 0 });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(readdirSync(captureParent)).toEqual([]);
  });

  it.each(["ETIMEDOUT", "ENOENT"])(
    "preserves the %s code with path-free output and removes the files",
    (code) => {
      makeCaptureParent();
      const result = spawnScenarioProcess("node", ["child.js"], options, {
        captureParent,
        spawnProcess: (_command, _args, spawnOptions) => {
          writeFileSync(spawnOptions.stdio[1], "fixed stage", "utf-8");
          return {
            status: null,
            error: Object.assign(new Error("/private/athlete-home/token"), { code }),
          };
        },
      });

      expect(result).toMatchObject({
        stdout: "fixed stage",
        stderr: "",
        status: null,
        error: { message: "scenario child process failed", code },
      });
      expect(JSON.stringify(result)).not.toContain("private/athlete-home");
      expect(readdirSync(captureParent)).toEqual([]);
    },
  );

  it("rejects oversized output without reading or retaining it", () => {
    makeCaptureParent();
    const result = spawnScenarioProcess("node", ["child.js"], { ...options, maxBuffer: 4 }, {
      captureParent,
      spawnProcess: (_command, _args, spawnOptions) => {
        writeFileSync(spawnOptions.stdio[1], "12345", "utf-8");
        return { status: 0 };
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

  it("returns after the direct child exits while its descendant still holds stdio", () => {
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
      const result = spawnScenarioProcess(
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
