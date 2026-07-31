import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical.js";
import { canRebaseline, rebaselineFixture } from "./rebaseline.js";
import type { S8aRecording, ScenarioVerdict } from "./types.js";

let root: string;
let fixtureDir: string;
let snapshotDir: string;

const recording: S8aRecording = {
  s8aRecordingVersion: 1,
  scenario: "rebaseline-test",
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
        system: "the recorded system",
        systemSha256_16: "1111111111111111",
        templateHash: "aaaaaaaaaaaaaaaa",
        assembledHash: "2222222222222222",
        messages: [{ role: "user", content: "hi" }],
        toolNames: ["intervals_fetch_wellness"],
        maxSteps: 10,
        cacheKey: "3333333333333333",
      },
      toolExecutions: [
        { seq: 0, toolName: "intervals_fetch_wellness", input: { oldest: "1998-06-29" }, resultCanonical: [] },
      ],
      result: { text: "reply", toolCalls: [], finishReason: "stop", usage: {}, totalUsage: {}, steps: 1 },
      events: null,
    },
  ],
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "s8a-rebaseline-test-"));
  fixtureDir = join(root, "fixture");
  snapshotDir = join(root, "snapshot-home");
  mkdirSync(join(fixtureDir, "baseline", "memory"), { recursive: true });
  writeFileSync(join(fixtureDir, "recording.json"), canonicalJson(recording) + "\n", "utf-8");
  writeFileSync(join(fixtureDir, "baseline", "memory", "MEMORY.md"), "# old baseline\n", "utf-8");
  mkdirSync(join(snapshotDir, "memory"), { recursive: true });
  writeFileSync(join(snapshotDir, "memory", "MEMORY.md"), "# new baseline\n", "utf-8");
  writeFileSync(join(snapshotDir, "usage-ledger.jsonl"), '{"kind":"generate"}\n', "utf-8");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("rebaseline", () => {
  it("refuses when an undocumented diff exists (exit 1 path, no writes)", () => {
    const verdicts: ScenarioVerdict[] = [
      {
        scenario: "rebaseline-test",
        pass: false,
        failures: [{ assertId: "A2", scenario: "rebaseline-test", detail: "undocumented tool drift" }],
      },
    ];
    const gate = canRebaseline(verdicts);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain("undocumented");
    // The orchestrator writes nothing when the gate refuses; the fixture is untouched.
    expect(readFileSync(join(fixtureDir, "baseline", "memory", "MEMORY.md"), "utf-8")).toBe("# old baseline\n");
  });

  it("allows a run that is green modulo registry-matched WARNs", () => {
    const verdicts: ScenarioVerdict[] = [
      {
        scenario: "rebaseline-test",
        pass: true,
        failures: [],
        warns: [{ assertId: "A1", scenario: "rebaseline-test", detail: "documented supersession S8A-SUP-001" }],
      },
    ];
    expect(canRebaseline(verdicts).ok).toBe(true);
  });

  it("re-mints baseline + lineage header and leaves calls[].request AND calls[].result byte-identical", () => {
    const before = JSON.parse(readFileSync(join(fixtureDir, "recording.json"), "utf-8")) as S8aRecording;
    const requestBytesBefore = canonicalJson(before.calls.map((c) => c.request));
    const resultBytesBefore = canonicalJson(before.calls.map((c) => c.result));

    rebaselineFixture({ fixtureDir, snapshotHomeDir: snapshotDir, liveTemplateHash: "bbbbbbbbbbbbbbbb" });

    const after = JSON.parse(readFileSync(join(fixtureDir, "recording.json"), "utf-8")) as S8aRecording;
    expect(after.lineage.templateHash).toBe("bbbbbbbbbbbbbbbb");
    expect(after.lineage.lineageVersion).toBe("unversioned");
    expect(canonicalJson(after.calls.map((c) => c.request))).toBe(requestBytesBefore);
    expect(canonicalJson(after.calls.map((c) => c.result))).toBe(resultBytesBefore);

    expect(readFileSync(join(fixtureDir, "baseline", "memory", "MEMORY.md"), "utf-8")).toBe("# new baseline\n");
    expect(readFileSync(join(fixtureDir, "baseline", "usage-ledger.jsonl"), "utf-8")).toBe('{"kind":"generate"}\n');
  });
});
