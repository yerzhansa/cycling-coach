import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type {
  BinaryConfig,
  CoreDeps,
  MemorySectionSpec,
  Sport,
  ToolRegistration,
} from "../src/index.js";

import { baseAgentConfig } from "./helpers/base-agent-config.js";

// ---------------------------------------------------------------------------
// Stub running-coach Sport — the load-bearing proof that Core is sport-agnostic.
// ---------------------------------------------------------------------------

const runningSections: readonly MemorySectionSpec[] = [
  { name: "running-profile", description: "VDOT, easy pace, recent race times" },
  { name: "running-equipment", description: "Shoes, watch, footstrike notes" },
  { name: "running-history", description: "Injuries, mileage history, peak weeks" },
];

const stubRunningSport: Sport = {
  id: "running",
  soul: "",
  skills: {},
  sessionClusterGapMinutes: 30,
  memorySections: runningSections,
  mustPreserveTokens: () => ["VDOT"],
  intervalsActivityTypes: ["Run", "TrailRun"],
  athleteProfileSchema: z.object({}),
  tools: (_deps: CoreDeps): readonly ToolRegistration[] => {
    // Compose only Core's generic memory tools. Sport-specific tools (zones,
    // plan-skeleton, intervals.icu workouts) would land here for a real sport.
    return [];
  },
};

const stubRunningBinary: BinaryConfig = {
  binaryName: "running-coach",
  displayName: "Running Coach",
  dataSubdir: "running",
  keychainPrefix: "running-coach",
  homeEnvVar: "RUNNING_COACH_HOME",
};

// ---------------------------------------------------------------------------

describe("Core is sport-agnostic — CoachAgent constructs and chats with a non-cycling Sport", () => {
  let tempHome: string;
  let origHome: string | undefined;
  let dataDir: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "cc-run-binary-"));
    origHome = process.env.HOME;
    process.env.HOME = tempHome;
    dataDir = join(tempHome, ".running-coach");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(dataDir, "memory"), { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(tempHome, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("constructs CoachAgent with stubRunningSport and round-trips a chat through a mocked codex LLM", async () => {
    const complete = vi.fn(async () => ({
      text: "ack from running-coach",
      toolCalls: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
      },
      stopReason: "stop" as const,
    }));

    vi.doMock("../src/agent/codex/responses.js", () => ({
      codexResponses: complete,
    }));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(),
      loginCodex: vi.fn(),
    }));
    vi.doMock("../src/auth/profiles.js", () => ({
      getFreshToken: vi.fn(async () => "token"),
      loadProfile: vi.fn(),
      saveProfile: vi.fn(),
      RefreshTokenReusedError: class extends Error {},
    }));

    const { CoachAgent } = await import("../src/agent/coach-agent.js");
    const agent = new CoachAgent(stubRunningSport, baseAgentConfig(dataDir));
    const text = await agent.chat("running-test", "hi");

    expect(text).toBe("ack from running-coach");
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// runBinary CLI routing — version command, unknown command
// ---------------------------------------------------------------------------

describe("runBinary CLI routing", () => {
  let origArgv: string[];
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    origArgv = process.argv;
    vi.resetModules();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit_${code ?? 0}`);
    }) as never);
  });

  afterEach(() => {
    process.argv = origArgv;
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("`version` command prints `${binary.binaryName} v<version>` and returns without exit", async () => {
    process.argv = ["node", "running-coach", "version"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await runBinary(stubRunningSport, stubRunningBinary);

    const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).toMatch(/^running-coach v/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("unknown command prints USAGE then exits with code 1", async () => {
    process.argv = ["node", "running-coach", "bogus"];
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { runBinary } = await import("../src/run-binary.js");
    await expect(runBinary(stubRunningSport, stubRunningBinary)).rejects.toThrow("__exit_1");

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("Unknown command: bogus"))).toBe(true);
  });
});
