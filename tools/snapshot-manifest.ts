/**
 * Pure builders for the snapshot oracle's `manifest.json`, split out of
 * the harness CLI so they're unit-testable without booting Pyodide
 * (snapshot-section-11.ts runs `main()` at module load).
 *
 * Two construction paths:
 *  - `buildManifest` — the full-regen path: the manifest is the index of
 *    every fixture the run just processed.
 *  - `mergeManifestForDebug` — the single-fixture debug path
 *    (SNAPSHOT_FIXTURE_PATH): the run only touched one fixture, so the
 *    manifest must be PATCHED into the existing index, not rebuilt from
 *    the one slug — otherwise the other fixtures silently vanish from the
 *    index while their snapshot files stay on disk (a lying manifest).
 */

import { existsSync, readFileSync } from "node:fs";

import type { Manifest } from "./check-metric-parity";
import { DEFAULT_FROZEN_NOW } from "./harness-fixtures.js";

export interface FixtureResult {
  slug: string;
  metrics: string[];
}

export interface ManifestCoordinates {
  sha: string;
  protocolVersion: string;
  commitDate: string;
  pyodideVersion: string;
}

const OFFLINE_MODE = "A_stub_requests_plus_monkey_patch" as const;

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function composeManifest(
  coords: ManifestCoordinates,
  fixtures: string[],
  metrics: string[],
): Manifest {
  // Field order is load-bearing: JSON.stringify preserves insertion order,
  // and the determinism test asserts byte-identical manifests across runs.
  return {
    section_11_sha: coords.sha,
    section_11_protocol_version: coords.protocolVersion,
    section_11_commit_date: coords.commitDate,
    fixtures,
    metrics,
    pyodide_version: coords.pyodideVersion,
    frozen_now: DEFAULT_FROZEN_NOW,
    offline_mode: OFFLINE_MODE,
  };
}

export function buildManifest(
  results: FixtureResult[],
  coords: ManifestCoordinates,
): Manifest {
  return composeManifest(
    coords,
    dedupeSorted(results.map((r) => r.slug)),
    dedupeSorted(results.flatMap((r) => r.metrics)),
  );
}

export function mergeManifestForDebug(
  existing: Manifest,
  results: FixtureResult[],
  coords: ManifestCoordinates,
): Manifest {
  assertCoordinatesMatch(existing, coords);
  return composeManifest(
    coords,
    dedupeSorted([...existing.fixtures, ...results.map((r) => r.slug)]),
    dedupeSorted([...existing.metrics, ...results.flatMap((r) => r.metrics)]),
  );
}

function assertCoordinatesMatch(
  existing: Manifest,
  coords: ManifestCoordinates,
): void {
  const drift: string[] = [];
  if (existing.section_11_sha !== coords.sha) {
    drift.push(`sha: ${existing.section_11_sha} -> ${coords.sha}`);
  }
  if (existing.section_11_protocol_version !== coords.protocolVersion) {
    drift.push(
      `protocol_version: ${existing.section_11_protocol_version} -> ${coords.protocolVersion}`,
    );
  }
  if (existing.section_11_commit_date !== coords.commitDate) {
    drift.push(
      `commit_date: ${existing.section_11_commit_date} -> ${coords.commitDate}`,
    );
  }
  if (existing.pyodide_version !== coords.pyodideVersion) {
    drift.push(
      `pyodide_version: ${existing.pyodide_version} -> ${coords.pyodideVersion}`,
    );
  }
  if (drift.length > 0) {
    throw new Error(
      `Debug regen (SNAPSHOT_FIXTURE_PATH) refused: the existing manifest's ` +
        `oracle coordinates differ from the current toolchain:\n  ${drift.join("\n  ")}\n` +
        `Merging one fixture would leave the other fixtures' entries pinned to ` +
        `stale coordinates. Run a full \`pnpm snapshot:section-11\` to regenerate ` +
        `every fixture against the current toolchain.`,
    );
  }
}

export function loadManifestForDebugOrThrow(manifestPath: string): Manifest {
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Debug regen (SNAPSHOT_FIXTURE_PATH) requires an existing manifest at ` +
        `${manifestPath}, but none was found. A debug regen patches one fixture ` +
        `into an already-initialized snapshot tree; run a full ` +
        `\`pnpm snapshot:section-11\` once to initialize it before iterating on a ` +
        `single fixture.`,
    );
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
}
