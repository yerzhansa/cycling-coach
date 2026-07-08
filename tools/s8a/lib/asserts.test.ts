import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DIFF_FILES,
  assertLedgerAndSessions,
  assertMemory,
  assertNeedles,
  assertSessionLineagePairs,
  collectSessionLineage,
  resolvePendings,
  writeDiffFiles,
} from "./asserts.js";
import type { FailureWithDiff, S8aRecording, S8aScenario } from "./types.js";

let root: string;
let runDir: string;
let baselineDir: string;
let homeDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "s8a-asserts-test-"));
  runDir = join(root, "run");
  baselineDir = join(root, "baseline");
  homeDir = join(root, "home");
  for (const d of [runDir, baselineDir, homeDir]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(dir: string, rel: string, content: string): void {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

const scenarioStub: S8aScenario = {
  id: "asserts-test",
  tier: "replay",
  description: "synthetic",
  intervals: {},
  turns: [{ chatId: "c1", userMessage: "hi" }],
};

describe("diff files (A1-A6 each write their named file)", () => {
  it("A1 system-prompt.diff via pending resolution", () => {
    const { failures } = resolvePendings(
      [
        {
          ordinal: 0,
          assertId: "A1",
          turn: { chatId: "c1", turnIndex: 0 },
          recordedTemplateHash: "aaaaaaaaaaaaaaaa",
          detail: "hash mismatch",
          recordedText: "recorded words",
          liveText: "live words",
        },
      ],
      new Map(),
      [],
    );
    const reported = writeDiffFiles(runDir, failures);
    expect(reported[0].diffFile).toBe(DIFF_FILES.A1);
    expect(existsSync(join(runDir, "system-prompt.diff"))).toBe(true);
  });

  it("A2/A3/A6 write tool-calls.diff, messages.diff, budget.diff", () => {
    const failures: FailureWithDiff[] = [
      { assertId: "A2", scenario: "s", detail: "d", diffFile: DIFF_FILES.A2, diffContent: "x" },
      { assertId: "A3", scenario: "s", detail: "d", diffFile: DIFF_FILES.A3, diffContent: "x" },
      { assertId: "A6", scenario: "s", detail: "d", diffFile: DIFF_FILES.A6, diffContent: "x" },
    ];
    writeDiffFiles(runDir, failures);
    for (const name of ["tool-calls.diff", "messages.diff", "budget.diff"]) {
      expect(existsSync(join(runDir, name))).toBe(true);
    }
  });

  it("A4 memory divergence writes memory.diff", () => {
    write(baselineDir, "memory/MEMORY.md", "# baseline profile\n");
    write(homeDir, "memory/MEMORY.md", "# live profile\n");
    const failures = assertMemory("asserts-test", baselineDir, homeDir);
    expect(failures).toHaveLength(1);
    expect(failures[0].assertId).toBe("A4");
    writeDiffFiles(runDir, failures);
    expect(existsSync(join(runDir, "memory.diff"))).toBe(true);
  });

  it("A5 ledger divergence writes ledger.diff", () => {
    write(baselineDir, "usage-ledger.jsonl", '{"kind":"generate","model":"a"}\n');
    write(homeDir, "usage-ledger.jsonl", '{"kind":"generate","model":"b"}\n');
    const failures = assertLedgerAndSessions("asserts-test", baselineDir, homeDir, []);
    expect(failures).toHaveLength(1);
    expect(failures[0].assertId).toBe("A5");
    writeDiffFiles(runDir, failures);
    expect(existsSync(join(runDir, "ledger.diff"))).toBe(true);
  });
});

describe("A4 memory compare", () => {
  it("passes on identical content and key-reordered jsonl", () => {
    write(baselineDir, "memory/MEMORY.md", "# same\n");
    write(homeDir, "memory/MEMORY.md", "# same\n");
    write(baselineDir, "memory/events.jsonl", '{"a":1,"b":2}\n');
    write(homeDir, "memory/events.jsonl", '{"b":2,"a":1}\n');
    expect(assertMemory("asserts-test", baselineDir, homeDir)).toEqual([]);
  });

  it("fails two-way on file presence", () => {
    write(baselineDir, "memory/MEMORY.history.jsonl", '{"a":1}\n');
    const missingLive = assertMemory("asserts-test", baselineDir, homeDir);
    expect(missingLive.some((f) => f.detail.includes("missing live"))).toBe(true);

    rmSync(join(baselineDir, "memory"), { recursive: true });
    mkdirSync(join(baselineDir, "memory"), { recursive: true });
    write(homeDir, "memory/MEMORY.history.jsonl", '{"a":1}\n');
    const missingBaseline = assertMemory("asserts-test", baselineDir, homeDir);
    expect(missingBaseline.some((f) => f.detail.includes("missing from baseline"))).toBe(true);
  });
});

describe("A5 two-way session compare", () => {
  it("flags a baseline session file missing live and vice versa", () => {
    write(baselineDir, "sessions/c1.jsonl", '{"role":"user","content":"x","ts":"1998-07-06T09:00:00.000Z"}\n');
    const missingLive = assertLedgerAndSessions("asserts-test", baselineDir, homeDir, []);
    expect(missingLive.some((f) => f.assertId === "A5" && f.detail.includes("missing live"))).toBe(true);

    write(homeDir, "sessions/c1.jsonl", '{"role":"user","content":"x","ts":"1998-07-06T09:00:00.000Z"}\n');
    write(homeDir, "sessions/c2.jsonl", '{"role":"user","content":"y","ts":"1998-07-06T09:00:00.000Z"}\n');
    const missingBaseline = assertLedgerAndSessions("asserts-test", baselineDir, homeDir, []);
    expect(
      missingBaseline.some((f) => f.assertId === "A5" && f.detail.includes("missing from baseline")),
    ).toBe(true);
  });
});

describe("A1 session-line lineage pairs", () => {
  const recording: S8aRecording = {
    s8aRecordingVersion: 1,
    scenario: "asserts-test",
    recordedAt: "1998-07-06T09:00:00.000Z",
    provider: "anthropic",
    model: "m",
    lineage: { templateHash: "aaaaaaaaaaaaaaaa", lineageVersion: "unversioned" },
    calls: [
      {
        ordinal: 0,
        caller: "chat",
        turn: { chatId: "c1", turnIndex: 0 },
        request: {
          shape: "messages",
          caller: "chat",
          system: "s",
          systemSha256_16: "x",
          templateHash: "aaaaaaaaaaaaaaaa",
          assembledHash: "bbbbbbbbbbbbbbbb",
          messages: [],
          toolNames: [],
          maxSteps: 10,
          cacheKey: "k",
        },
        toolExecutions: [],
        result: { text: "t", toolCalls: [], finishReason: "stop", usage: {}, totalUsage: {}, steps: 1 },
        events: null,
      },
    ],
  };

  it("passes when the live pair matches and fails when it drifts", () => {
    const good = new Map([["c1", [{ templateHash: "aaaaaaaaaaaaaaaa", assembledHash: "bbbbbbbbbbbbbbbb" }]]]);
    expect(assertSessionLineagePairs("asserts-test", recording, good, [])).toEqual([]);

    const drifted = new Map([["c1", [{ templateHash: "eeeeeeeeeeeeeeee", assembledHash: "bbbbbbbbbbbbbbbb" }]]]);
    const failures = assertSessionLineagePairs("asserts-test", recording, drifted, []);
    expect(failures).toHaveLength(1);
    expect(failures[0].assertId).toBe("A1");
  });

  it("collectSessionLineage reads lineage-bearing assistant lines in order", () => {
    write(
      homeDir,
      "sessions/c1.jsonl",
      [
        '{"role":"user","content":"u","ts":"1998-07-06T09:00:00.000Z"}',
        '{"role":"assistant","content":"a","ts":"1998-07-06T09:00:00.000Z","templateHash":"1111111111111111","assembledHash":"2222222222222222"}',
        '{"role":"assistant","content":"no-lineage","ts":"1998-07-06T09:00:00.000Z"}',
      ].join("\n") + "\n",
    );
    const lineage = collectSessionLineage(homeDir);
    expect(lineage.get("c1")).toEqual([
      { templateHash: "1111111111111111", assembledHash: "2222222222222222" },
    ]);
  });
});

describe("A7 needles", () => {
  it("evaluates forbidden needles (string and regex) per turn", () => {
    const scenario: S8aScenario = {
      ...scenarioStub,
      forbiddenNeedles: ["S8A-CANARY-X", /\bbanned\b/],
    };
    const failures = assertNeedles(scenario, ["clean reply", "this is banned text S8A-CANARY-X"]);
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.assertId === "A7")).toBe(true);
    expect(failures.every((f) => f.detail.includes('"turn":1'))).toBe(true);
  });

  it("requires required needles to match at least one reply", () => {
    const scenario: S8aScenario = { ...scenarioStub, requiredNeedles: [/zone 2/i, "watts"] };
    expect(assertNeedles(scenario, ["Ride two hours in Zone 2 at around 180 watts."])).toEqual([]);
    const failures = assertNeedles(scenario, ["no structural facts here"]);
    expect(failures).toHaveLength(2);
    expect(failures.every((f) => f.detail.includes('"kind":"required"'))).toBe(true);
  });
});
