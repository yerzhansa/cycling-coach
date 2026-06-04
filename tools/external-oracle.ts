/**
 * External-oracle cross-check for the parity gate.
 *
 * The external oracle is a second, independent implementation that
 * computes mean-max power/HR curves from the same underlying rides the
 * `curve-equipped` fixture's curve blocks aggregate. Its outputs land as
 * immutable snapshot JSONs under
 * `packages/core/tests/fixtures/external-oracle-snapshots/<fixture>/`.
 *
 * This module reads those snapshots, resolves each declared
 * external-coverage entry's fixture anchor, and asserts the documented
 * relation between the fixture's (integer-floored) curve anchors and the
 * oracle's (float) mean-max values.
 *
 * The tolerance is NOT defined here. It is read from
 * `tools/intentional-deviations.yaml`'s `external_coverage:` section —
 * the single tolerance surface the gate honors. A tolerance kind the
 * registry declares but this module does not implement is a hard error,
 * never a silent pass.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { REPO_ROOT } from "./check-metric-parity.js";

const DEVIATIONS_PATH = resolve(REPO_ROOT, "tools/intentional-deviations.yaml");
const EXTERNAL_SNAPSHOTS_ROOT = resolve(
  REPO_ROOT,
  "packages/core/tests/fixtures/external-oracle-snapshots",
);
const GOLDEN_ROOT = resolve(REPO_ROOT, "packages/core/tests/fixtures/golden");

// ─── External-coverage registry schema ─────────────────────────────────
//
// A separate top-level section from `deviations:` — these are not
// section-11-deviation records, they are tolerance/coverage records for
// the external oracle. Strict per-shape so a typo fails loud.

export const FLOOR_INT_TOLERANCE_KIND = "floor_int";

const ExternalAnchorSchema = z
  .object({
    fixture_path: z.string(),
    oracle_path: z.string(),
    window_id: z.string(),
    units: z.string(),
  })
  .strict();

const ExternalToleranceSchema = z
  .object({
    kind: z.string(),
    max_offset: z.number(),
  })
  .strict();

const ExternalCoveredEntrySchema = z
  .object({
    quantity: z.string(),
    fixture: z.string(),
    anchor: ExternalAnchorSchema,
    tolerance: ExternalToleranceSchema,
    computed_by: z.string(),
    rationale: z.string(),
  })
  .strict();

const ExternalUncoveredEntrySchema = z
  .object({
    quantity: z.string(),
    fixture: z.string(),
    covered: z.literal(false),
    reason: z.string(),
  })
  .strict();

export const ExternalCoverageEntrySchema = z.union([
  ExternalCoveredEntrySchema,
  ExternalUncoveredEntrySchema,
]);
export type ExternalCoverageEntry = z.infer<typeof ExternalCoverageEntrySchema>;
export type ExternalCoveredEntry = z.infer<typeof ExternalCoveredEntrySchema>;

export function isCovered(
  entry: ExternalCoverageEntry,
): entry is ExternalCoveredEntry {
  return !("covered" in entry && entry.covered === false);
}

// The registry file as a whole carries `schema_version`, `deviations`,
// and the optional `external_coverage` section. Only the last is parsed
// here; the gate's own loader handles `deviations`.
const RegistryWithExternalSchema = z
  .object({
    schema_version: z.literal(1),
    deviations: z.array(z.unknown()),
    external_coverage: z.array(ExternalCoverageEntrySchema).optional(),
  })
  .strict();

let externalCoverageCache: ExternalCoverageEntry[] | undefined;

export function loadExternalCoverage(): ExternalCoverageEntry[] {
  if (externalCoverageCache === undefined) {
    const raw = readFileSync(DEVIATIONS_PATH, "utf8");
    const parsed = parseYaml(raw);
    const result = RegistryWithExternalSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `tools/intentional-deviations.yaml external_coverage failed schema validation:\n${result.error.message}`,
      );
    }
    externalCoverageCache = result.data.external_coverage ?? [];
  }
  return externalCoverageCache;
}

export function __resetExternalCoverageCacheForTesting(): void {
  externalCoverageCache = undefined;
}

// ─── External snapshot loader ──────────────────────────────────────────

export const ExternalSnapshotSchema = z
  .object({
    metric: z.string(),
    athlete: z.string(),
    oracle: z.literal("external"),
    oracle_version: z.string(),
    oracle_arch: z.string(),
    oracle_host_os: z.string(),
    frozen_now: z.string(),
    value: z.unknown(),
  })
  .loose();
export type ExternalSnapshot = z.infer<typeof ExternalSnapshotSchema>;

export function externalSnapshotPath(fixture: string, quantity: string): string {
  return resolve(EXTERNAL_SNAPSHOTS_ROOT, fixture, `${quantity}.json`);
}

export function loadExternalSnapshot(
  fixture: string,
  quantity: string,
): ExternalSnapshot | undefined {
  let raw: string;
  try {
    raw = readFileSync(externalSnapshotPath(fixture, quantity), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const parsed = ExternalSnapshotSchema.parse(JSON.parse(raw));
  return parsed;
}

// ─── Fixture anchor resolution ─────────────────────────────────────────
//
// The fixture-side anchors live inside curve blocks selected by id. The
// `fixture_path` in the registry uses a small dotted-with-[id=...]
// grammar, e.g.
//   power_curves.list[id=r.2026-05-08.2026-06-04]
//   sustainability_curves.cycling.power.Ride.list[id=r.2026-04-24.2026-06-04]
// resolving to the matching `{secs[], watts[]|values[]}` curve object.
// Its anchors are returned as a `{ "<sec>": value }` map keyed the same
// way the oracle's `value.mean_max` map is keyed (string seconds).

interface CurveBlock {
  id: string;
  secs: number[];
  watts?: number[];
  values?: number[];
}

function readJson(fixture: string): unknown {
  return JSON.parse(
    readFileSync(resolve(GOLDEN_ROOT, `${fixture}.json`), "utf8"),
  );
}

// Split a dotted path on `.`, but never inside a `[...]` selector — the
// curve ids (`r.2026-05-08.2026-06-04`) carry literal dots that must stay
// glued to their `list[id=...]` segment.
function splitFixturePath(fixturePath: string): string[] {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of fixturePath) {
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    if (ch === "." && depth === 0) {
      segments.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function resolveCurveBlock(
  fixtureData: unknown,
  fixturePath: string,
): CurveBlock {
  const segments = splitFixturePath(fixturePath);
  let node: unknown = fixtureData;
  for (const segment of segments) {
    const listMatch = segment.match(/^list\[id=(.+)\]$/);
    if (listMatch) {
      const wantedId = listMatch[1];
      const list = (node as { list?: unknown[] })?.list;
      if (!Array.isArray(list)) {
        throw new Error(
          `fixture anchor '${fixturePath}': expected a 'list' array at this segment`,
        );
      }
      const found = list.find(
        (c) => (c as { id?: string }).id === wantedId,
      ) as CurveBlock | undefined;
      if (!found) {
        throw new Error(
          `fixture anchor '${fixturePath}': no curve with id '${wantedId}' in list`,
        );
      }
      node = found;
      continue;
    }
    node = (node as Record<string, unknown>)?.[segment];
    if (node === undefined) {
      throw new Error(
        `fixture anchor '${fixturePath}': segment '${segment}' resolved to undefined`,
      );
    }
  }
  return node as CurveBlock;
}

function curveAnchorMap(block: CurveBlock): Record<string, number> {
  const vals = block.watts ?? block.values;
  if (!Array.isArray(block.secs) || !Array.isArray(vals)) {
    throw new Error(
      `curve block id '${block.id}' is missing secs[] or watts[]/values[]`,
    );
  }
  const out: Record<string, number> = {};
  for (let i = 0; i < block.secs.length; i++) {
    out[String(block.secs[i])] = vals[i]!;
  }
  return out;
}

// ─── Cross-check ───────────────────────────────────────────────────────

export interface AnchorDiff {
  anchorSecs: string;
  fixture: number;
  oracle: number;
  offset: number;
  reason: string;
}

export interface QuantityCrossCheck {
  quantity: string;
  fixture: string;
  windowId: string;
  comparedAnchors: number;
  passed: boolean;
  failures: AnchorDiff[];
  /** Anchors present in the fixture block but absent from the oracle map
   * (or vice versa): not failures, reported for transparency. */
  unmatchedAnchors: string[];
}

function assertFloorIntKind(kind: string, quantity: string): void {
  if (kind !== FLOOR_INT_TOLERANCE_KIND) {
    throw new Error(
      `external_coverage entry '${quantity}' declares tolerance.kind '${kind}', ` +
        `which the gate does not implement. The only honored kind is ` +
        `'${FLOOR_INT_TOLERANCE_KIND}'. Add the relation to tools/external-oracle.ts ` +
        `or fix the registry — the gate never invents a tolerance.`,
    );
  }
}

/**
 * Cross-check one covered quantity. Returns `undefined` when the external
 * snapshot for the quantity is absent on disk — the caller decides whether
 * a missing snapshot is a skip (external mode) or a failure (both mode).
 */
export function crossCheckQuantity(
  entry: ExternalCoveredEntry,
): QuantityCrossCheck | undefined {
  assertFloorIntKind(entry.tolerance.kind, entry.quantity);

  const snap = loadExternalSnapshot(entry.fixture, entry.quantity);
  if (snap === undefined) return undefined;

  const oracleMeanMax = resolveOraclePath(snap, entry.anchor.oracle_path);
  const fixtureData = readJson(entry.fixture);
  const block = resolveCurveBlock(fixtureData, entry.anchor.fixture_path);
  const fixtureAnchors = curveAnchorMap(block);

  const oracleKeys = new Set(Object.keys(oracleMeanMax));
  const fixtureKeys = new Set(Object.keys(fixtureAnchors));
  const shared = [...oracleKeys].filter((k) => fixtureKeys.has(k));
  const unmatched = [
    ...[...oracleKeys].filter((k) => !fixtureKeys.has(k)),
    ...[...fixtureKeys].filter((k) => !oracleKeys.has(k)),
  ].sort((a, b) => Number(a) - Number(b));

  const failures: AnchorDiff[] = [];
  for (const sec of shared.sort((a, b) => Number(a) - Number(b))) {
    const oracle = oracleMeanMax[sec]!;
    const fixture = fixtureAnchors[sec]!;
    const offset = oracle - fixture;
    // floor_int relation: fixture must equal floor(oracle); equivalently
    // 0 <= oracle - fixture < 1. max_offset is the documented bound — a
    // value at-or-beyond it is a failure to surface, not a tolerance to
    // stretch.
    const floorOk = fixture === Math.floor(oracle);
    const offsetOk = offset >= 0 && offset < 1;
    const withinBound = offset <= entry.tolerance.max_offset;
    if (!floorOk || !offsetOk || !withinBound) {
      const reasons: string[] = [];
      if (!floorOk) reasons.push(`fixture ${fixture} !== floor(${oracle})`);
      if (!offsetOk) reasons.push(`offset ${offset} not in [0, 1)`);
      if (!withinBound)
        reasons.push(
          `offset ${offset} exceeds documented max_offset ${entry.tolerance.max_offset}`,
        );
      failures.push({
        anchorSecs: sec,
        fixture,
        oracle,
        offset,
        reason: reasons.join("; "),
      });
    }
  }

  return {
    quantity: entry.quantity,
    fixture: entry.fixture,
    windowId: entry.anchor.window_id,
    comparedAnchors: shared.length,
    passed: failures.length === 0 && shared.length > 0,
    failures:
      shared.length === 0
        ? [
            {
              anchorSecs: "—",
              fixture: Number.NaN,
              oracle: Number.NaN,
              offset: Number.NaN,
              reason:
                "no shared anchors between oracle mean_max and fixture curve block",
            },
          ]
        : failures,
    unmatchedAnchors: unmatched,
  };
}

function resolveOraclePath(
  snap: ExternalSnapshot,
  oraclePath: string,
): Record<string, number> {
  let node: unknown = snap;
  for (const segment of oraclePath.split(".")) {
    node = (node as Record<string, unknown>)?.[segment];
    if (node === undefined) {
      throw new Error(
        `oracle anchor '${oraclePath}': segment '${segment}' resolved to undefined`,
      );
    }
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new Error(
      `oracle anchor '${oraclePath}' did not resolve to a { sec: value } map`,
    );
  }
  return node as Record<string, number>;
}

// ─── Run the full external matrix for a fixture ───────────────────────

export interface ExternalRunResult {
  fixture: string;
  checks: QuantityCrossCheck[];
  uncovered: { quantity: string; reason: string }[];
  /** Covered entries whose external snapshot was absent on disk. */
  missingSnapshots: string[];
  coveredCount: number;
  passedCount: number;
  failedCount: number;
}

/**
 * Run every covered external-coverage entry for `fixture`. Entries for
 * other fixtures are ignored. Missing snapshots are collected separately
 * (the caller decides skip-vs-fail). Quantities flagged `covered: false`
 * are reported as uncovered.
 */
export function runExternalForFixture(fixture: string): ExternalRunResult {
  const coverage = loadExternalCoverage().filter((e) => e.fixture === fixture);

  const checks: QuantityCrossCheck[] = [];
  const uncovered: { quantity: string; reason: string }[] = [];
  const missingSnapshots: string[] = [];

  for (const entry of coverage) {
    if (!isCovered(entry)) {
      uncovered.push({ quantity: entry.quantity, reason: entry.reason.trim() });
      continue;
    }
    const check = crossCheckQuantity(entry);
    if (check === undefined) {
      missingSnapshots.push(entry.quantity);
      continue;
    }
    checks.push(check);
  }

  const passedCount = checks.filter((c) => c.passed).length;
  return {
    fixture,
    checks,
    uncovered,
    missingSnapshots,
    coveredCount: checks.length,
    passedCount,
    failedCount: checks.length - passedCount,
  };
}
