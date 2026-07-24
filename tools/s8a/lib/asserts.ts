import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson } from "./canonical.js";
import { textDiff } from "./diff.js";
import { needleLabel, needleMatches } from "./needles.js";
import {
  findSupersession,
  isFieldExcused,
  resolvePending,
  type SupersessionEntry,
} from "./supersessions.js";
import type {
  AssertFailure,
  FailureWithDiff,
  PendingHashMismatch,
  S8aRecording,
  S8aScenario,
} from "./types.js";

// One named diff file per mechanical assert; A7 findings are listed inline in
// the verdict instead.
export const DIFF_FILES = {
  A1: "system-prompt.diff",
  A2: "tool-calls.diff",
  A3: "messages.diff",
  A4: "memory.diff",
  A5: "ledger.diff",
  A6: "budget.diff",
} as const;

export function writeDiffFiles(runDir: string, failures: FailureWithDiff[]): AssertFailure[] {
  const out: AssertFailure[] = [];
  for (const f of failures) {
    if (f.diffFile !== undefined && f.diffContent !== undefined) {
      const path = join(runDir, f.diffFile);
      mkdirSync(dirname(path), { recursive: true });
      // Multiple failures can share one diff file; append per-failure sections.
      const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
      writeFileSync(path, existing + f.diffContent + "\n", "utf-8");
    }
    out.push({
      assertId: f.assertId,
      scenario: f.scenario,
      detail: f.detail,
      ...(f.diffFile !== undefined ? { diffFile: f.diffFile } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A4 — memory writes
// ---------------------------------------------------------------------------

const MEMORY_BYTE_FILES = ["MEMORY.md"];
const MEMORY_JSONL_FILES = ["events.jsonl", "MEMORY.history.jsonl"];

export function assertMemory(
  scenarioId: string,
  baselineDir: string,
  homeDir: string,
): FailureWithDiff[] {
  const failures: FailureWithDiff[] = [];
  const sections: string[] = [];

  for (const name of [...MEMORY_BYTE_FILES, ...MEMORY_JSONL_FILES]) {
    const baselinePath = join(baselineDir, "memory", name);
    const livePath = join(homeDir, "memory", name);
    const inBaseline = existsSync(baselinePath);
    const inLive = existsSync(livePath);
    if (!inBaseline && !inLive) continue;
    if (inBaseline !== inLive) {
      const detail = `memory/${name}: ${inBaseline ? "present in baseline, missing live" : "present live, missing from baseline"}`;
      sections.push(`--- ${detail} ---`);
      failures.push({ assertId: "A4", scenario: scenarioId, detail, diffFile: DIFF_FILES.A4 });
      continue;
    }
    const baseline = readFileSync(baselinePath, "utf-8");
    const live = readFileSync(livePath, "utf-8");
    const equal = MEMORY_JSONL_FILES.includes(name)
      ? jsonlCanonical(baseline) === jsonlCanonical(live)
      : baseline === live;
    if (!equal) {
      const detail = `memory/${name}: content differs from baseline`;
      sections.push(`--- memory/${name} ---\n` + textDiff("baseline", baseline, "live", live));
      failures.push({ assertId: "A4", scenario: scenarioId, detail, diffFile: DIFF_FILES.A4 });
    }
  }

  if (sections.length > 0 && failures.length > 0) {
    failures[0].diffContent = sections.join("\n");
  }
  return failures;
}

function jsonlCanonical(content: string): string {
  return content
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => canonicalJson(JSON.parse(l)))
    .join("\n");
}

// ---------------------------------------------------------------------------
// A5 — ledger + session writes (two-way)
// ---------------------------------------------------------------------------

const DURABLE_RESET_ARCHIVE_PATTERN =
  /^(sessions\/.+\.jsonl\.reset\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z)\.[a-f0-9]{64}$/;

function artifactKey(relativePath: string): string {
  return DURABLE_RESET_ARCHIVE_PATTERN.exec(relativePath)?.[1] ?? relativePath;
}

function collectLedgerAndSessionArtifacts(rootDir: string): Map<string, string[]> {
  const artifacts = new Map<string, string[]>();
  const add = (relativePath: string) => {
    const key = artifactKey(relativePath);
    const paths = artifacts.get(key) ?? [];
    paths.push(relativePath);
    artifacts.set(key, paths);
  };

  if (existsSync(join(rootDir, "usage-ledger.jsonl"))) add("usage-ledger.jsonl");
  const sessionsDir = join(rootDir, "sessions");
  if (existsSync(sessionsDir)) {
    for (const name of readdirSync(sessionsDir)) add(join("sessions", name));
  }
  for (const paths of artifacts.values()) paths.sort();
  return artifacts;
}

export function assertLedgerAndSessions(
  scenarioId: string,
  baselineDir: string,
  homeDir: string,
  excuses: SupersessionEntry[],
): FailureWithDiff[] {
  const failures: FailureWithDiff[] = [];
  const sections: string[] = [];

  const baselineArtifacts = collectLedgerAndSessionArtifacts(baselineDir);
  const liveArtifacts = collectLedgerAndSessionArtifacts(homeDir);
  const artifactKeys = new Set([...baselineArtifacts.keys(), ...liveArtifacts.keys()]);

  for (const key of [...artifactKeys].sort()) {
    const baselinePaths = baselineArtifacts.get(key) ?? [];
    const livePaths = liveArtifacts.get(key) ?? [];
    const count = Math.max(baselinePaths.length, livePaths.length);
    for (let artifactIndex = 0; artifactIndex < count; artifactIndex++) {
      const baselineRelativePath = baselinePaths[artifactIndex];
      const liveRelativePath = livePaths[artifactIndex];
      if (baselineRelativePath === undefined || liveRelativePath === undefined) {
        const relativePath = baselineRelativePath ?? liveRelativePath ?? key;
        const detail = `${relativePath}: ${
          baselineRelativePath === undefined
            ? "present live, missing from baseline"
            : "present in baseline, missing live"
        }`;
        sections.push(`--- ${detail} ---`);
        failures.push({ assertId: "A5", scenario: scenarioId, detail, diffFile: DIFF_FILES.A5 });
        continue;
      }
      compareJsonlArtifact(
        scenarioId,
        key,
        join(baselineDir, baselineRelativePath),
        join(homeDir, liveRelativePath),
        excuses,
        failures,
        sections,
      );
    }
  }

  if (sections.length > 0 && failures.length > 0) {
    failures[0].diffContent = sections.join("\n");
  }
  return failures;
}

function compareJsonlArtifact(
  scenarioId: string,
  relativePath: string,
  baselinePath: string,
  livePath: string,
  excuses: SupersessionEntry[],
  failures: FailureWithDiff[],
  sections: string[],
): void {
  const baselineLines = jsonlLines(readFileSync(baselinePath, "utf-8"));
  const liveLines = jsonlLines(readFileSync(livePath, "utf-8"));
  const max = Math.max(baselineLines.length, liveLines.length);
  for (let i = 0; i < max; i++) {
    const b = baselineLines[i];
    const l = liveLines[i];
    if (b === undefined || l === undefined) {
      const detail = `${relativePath} line ${i + 1}: ${b === undefined ? "extra live line" : "missing live line"}`;
      sections.push(`--- ${detail} ---\n${canonicalJson(b ?? l)}`);
      failures.push({ assertId: "A5", scenario: scenarioId, detail, diffFile: DIFF_FILES.A5 });
      continue;
    }
    const mismatch = compareLineWithExcuses(b, l, excuses);
    if (mismatch !== null) {
      const detail = `${relativePath} line ${i + 1}: field(s) differ: ${mismatch.join(", ")}`;
      sections.push(
        `--- ${detail} ---\n` +
          textDiff("baseline line", canonicalJson(b), "live line", canonicalJson(l)),
      );
      failures.push({ assertId: "A5", scenario: scenarioId, detail, diffFile: DIFF_FILES.A5 });
    }
  }
}

function jsonlLines(content: string): Record<string, unknown>[] {
  return content
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Returns null when equal (modulo excused fields), else the differing field names. */
function compareLineWithExcuses(
  baseline: Record<string, unknown>,
  live: Record<string, unknown>,
  excuses: SupersessionEntry[],
): string[] | null {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(live)]);
  const differing: string[] = [];
  for (const key of keys) {
    if (canonicalJson(baseline[key] ?? null) === canonicalJson(live[key] ?? null)) continue;
    if (isFieldExcused({ entries: excuses, field: key, baselineLine: baseline, liveLine: live })) {
      continue;
    }
    differing.push(key);
  }
  return differing.length === 0 ? null : differing;
}

// ---------------------------------------------------------------------------
// A1 — PENDING supersession resolution + session-line pair checks
// ---------------------------------------------------------------------------

export interface TurnLineage {
  templateHash?: string;
  assembledHash?: string;
}

/** Lineage-bearing assistant lines per chatId, in file order — the join target
 *  for both the PENDING resolution and the per-turn hash-pair check. */
export function collectSessionLineage(homeDir: string): Map<string, TurnLineage[]> {
  const out = new Map<string, TurnLineage[]>();
  const dir = join(homeDir, "sessions");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const chatId = name.slice(0, -".jsonl".length);
    const lineages: TurnLineage[] = [];
    for (const line of jsonlLines(readFileSync(join(dir, name), "utf-8"))) {
      if (line.role === "assistant" && typeof line.templateHash === "string") {
        lineages.push({
          templateHash: line.templateHash as string,
          assembledHash: line.assembledHash as string | undefined,
        });
      }
    }
    out.set(chatId, lineages);
  }
  return out;
}

export function resolvePendings(
  pendings: PendingHashMismatch[],
  sessionLineage: Map<string, TurnLineage[]>,
  registry: SupersessionEntry[] | null,
): { failures: FailureWithDiff[]; warns: AssertFailure[] } {
  const failures: FailureWithDiff[] = [];
  const warns: AssertFailure[] = [];
  for (const pending of pendings) {
    const liveTemplateHash =
      pending.turn !== null
        ? (sessionLineage.get(pending.turn.chatId)?.[pending.turn.turnIndex]?.templateHash ?? null)
        : null;
    const resolution = resolvePending(pending, liveTemplateHash, registry);
    if (resolution.kind === "warn") {
      warns.push({
        assertId: pending.assertId,
        scenario: "",
        detail: resolution.detail,
      });
    } else {
      failures.push({
        assertId: pending.assertId,
        scenario: "",
        detail: resolution.detail,
        diffFile: DIFF_FILES.A1,
        diffContent: textDiff(
          "recorded system",
          pending.recordedText,
          "live system",
          pending.liveText,
        ),
      });
    }
  }
  return { failures, warns };
}

/** Per chat turn: the (templateHash, assembledHash) pair on the live session
 *  assistant line vs the turn's chat call's recorded request fields — modulo
 *  documented supersessions. */
export function assertSessionLineagePairs(
  scenarioId: string,
  recording: S8aRecording,
  sessionLineage: Map<string, TurnLineage[]>,
  registry: SupersessionEntry[] | null,
): FailureWithDiff[] {
  const failures: FailureWithDiff[] = [];
  for (const call of recording.calls) {
    if (call.caller !== "chat" || call.request.shape !== "messages" || call.turn === null) continue;
    const recorded = call.request;
    if (recorded.templateHash === undefined) continue;
    const live = sessionLineage.get(call.turn.chatId)?.[call.turn.turnIndex];
    if (live === undefined || live.templateHash === undefined) {
      failures.push({
        assertId: "A1",
        scenario: scenarioId,
        detail: `turn ${call.turn.turnIndex} (${call.turn.chatId}): no live session assistant line to compare lineage against`,
        diffFile: DIFF_FILES.A1,
        diffContent: `turn ${call.turn.turnIndex} (${call.turn.chatId}): expected a lineage-bearing session assistant line; none written`,
      });
      continue;
    }
    if (
      live.templateHash === recorded.templateHash &&
      live.assembledHash === recorded.assembledHash
    ) {
      continue;
    }
    if (
      registry !== null &&
      findSupersession(registry, recorded.templateHash, live.templateHash) !== undefined
    ) {
      continue; // Pair excused; the PENDING resolution already reported the WARN.
    }
    failures.push({
      assertId: "A1",
      scenario: scenarioId,
      detail:
        `turn ${call.turn.turnIndex} (${call.turn.chatId}): session-line lineage pair mismatch — ` +
        `live (${live.templateHash}, ${live.assembledHash}) vs recorded (${recorded.templateHash}, ${recorded.assembledHash})`,
      diffFile: DIFF_FILES.A1,
      diffContent:
        `turn ${call.turn.turnIndex} (${call.turn.chatId}) lineage pair:\n` +
        `recorded templateHash=${recorded.templateHash} assembledHash=${recorded.assembledHash}\n` +
        `live     templateHash=${live.templateHash} assembledHash=${live.assembledHash}`,
    });
  }
  return failures;
}

// ---------------------------------------------------------------------------
// A7 — needles
// ---------------------------------------------------------------------------

export function assertNeedles(scenario: S8aScenario, replies: string[]): FailureWithDiff[] {
  const failures: FailureWithDiff[] = [];
  for (const needle of scenario.forbiddenNeedles ?? []) {
    replies.forEach((reply, turn) => {
      if (needleMatches(needle, reply)) {
        failures.push({
          assertId: "A7",
          scenario: scenario.id,
          detail: JSON.stringify({
            needle: needleLabel(needle),
            kind: "forbidden",
            turn,
            matched: true,
          }),
        });
      }
    });
  }
  // A required needle is a structural fact the conversation must surface; it
  // must match at least one turn's final reply.
  for (const needle of scenario.requiredNeedles ?? []) {
    if (!replies.some((reply) => needleMatches(needle, reply))) {
      failures.push({
        assertId: "A7",
        scenario: scenario.id,
        detail: JSON.stringify({
          needle: needleLabel(needle),
          kind: "required",
          turn: null,
          matched: false,
        }),
      });
    }
  }
  return failures;
}
