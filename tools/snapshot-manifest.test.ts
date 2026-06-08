import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Manifest } from "./check-metric-parity";
import { DEFAULT_FROZEN_NOW } from "./harness-fixtures.js";
import {
  buildManifest,
  loadManifestForDebugOrThrow,
  type ManifestCoordinates,
  mergeManifestForDebug,
} from "./snapshot-manifest.js";

/**
 * Tests for the snapshot oracle's manifest builders. The full-regen path
 * (`buildManifest`) must stay byte-identical to the committed manifest; the
 * debug path (`mergeManifestForDebug`) must patch one fixture into the index
 * without dropping the others — the defect issue #015 documents.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_ROOT = resolve(
  __dirname,
  "../packages/core/tests/fixtures/snapshots",
);

const COORDS: ManifestCoordinates = {
  sha: "224c369d2f14a71725cb9157fc133cf3cff5cd32",
  protocolVersion: "3.112",
  commitDate: "2026-04-30T21:50:59+02:00",
  pyodideVersion: "0.29.4",
};

function manifestWith(overrides: Partial<Manifest>): Manifest {
  return {
    section_11_sha: COORDS.sha,
    section_11_protocol_version: COORDS.protocolVersion,
    section_11_commit_date: COORDS.commitDate,
    fixtures: ["alpha", "beta"],
    metrics: ["acwr", "monotony", "strain"],
    pyodide_version: COORDS.pyodideVersion,
    frozen_now: DEFAULT_FROZEN_NOW,
    offline_mode: "A_stub_requests_plus_monkey_patch",
    ...overrides,
  };
}

describe("buildManifest", () => {
  it("sorts + dedupes fixtures and metrics with the canonical field order", () => {
    const manifest = buildManifest(
      [
        { slug: "beta", metrics: ["monotony", "acwr"] },
        { slug: "alpha", metrics: ["acwr", "strain"] },
      ],
      COORDS,
    );
    expect(manifest.fixtures).toEqual(["alpha", "beta"]);
    expect(manifest.metrics).toEqual(["acwr", "monotony", "strain"]);
    expect(Object.keys(manifest)).toEqual([
      "section_11_sha",
      "section_11_protocol_version",
      "section_11_commit_date",
      "fixtures",
      "metrics",
      "pyodide_version",
      "frozen_now",
      "offline_mode",
    ]);
    expect(manifest.frozen_now).toBe(DEFAULT_FROZEN_NOW);
    expect(manifest.offline_mode).toBe("A_stub_requests_plus_monkey_patch");
  });

  it("reconstructs the committed manifest byte-identically from the on-disk snapshot tree", () => {
    // The hermetic byte-identity gate: prove the extraction matches the
    // committed full-regen manifest WITHOUT booting Pyodide. If buildManifest
    // ever drifts from the inline construction this catches it.
    const committedBytes = readFileSync(
      join(SNAPSHOTS_ROOT, "manifest.json"),
      "utf8",
    );
    const committed = JSON.parse(committedBytes) as Manifest;

    const slugs = readdirSync(SNAPSHOTS_ROOT).filter((entry) =>
      statSync(join(SNAPSHOTS_ROOT, entry)).isDirectory(),
    );
    const results = slugs.map((slug) => ({
      slug,
      metrics: readdirSync(join(SNAPSHOTS_ROOT, slug))
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, "")),
    }));

    const rebuilt = buildManifest(results, {
      sha: committed.section_11_sha,
      protocolVersion: committed.section_11_protocol_version,
      commitDate: committed.section_11_commit_date,
      pyodideVersion: committed.pyodide_version,
    });
    expect(`${JSON.stringify(rebuilt, null, 2)}\n`).toBe(committedBytes);
  });
});

describe("mergeManifestForDebug", () => {
  it("patches one fixture into the index, preserving every other entry", () => {
    const existing = manifestWith({
      fixtures: ["alpha", "beta", "gamma"],
      metrics: ["acwr", "monotony", "strain"],
    });
    const merged = mergeManifestForDebug(
      existing,
      [{ slug: "beta", metrics: ["acwr", "monotony"] }],
      COORDS,
    );
    expect(merged.fixtures).toEqual(["alpha", "beta", "gamma"]);
    expect(merged.metrics).toEqual(["acwr", "monotony", "strain"]);
  });

  it("is a no-op (byte-identical) when re-merging an already-indexed fixture", () => {
    const existing = manifestWith({
      fixtures: ["alpha", "beta", "gamma"],
      metrics: ["acwr", "monotony", "strain"],
    });
    const merged = mergeManifestForDebug(
      existing,
      [{ slug: "beta", metrics: ["acwr", "monotony", "strain"] }],
      COORDS,
    );
    expect(JSON.stringify(merged)).toBe(JSON.stringify(existing));
  });

  it("adds a new fixture's slug + any new metrics to the union", () => {
    const existing = manifestWith({
      fixtures: ["alpha", "beta"],
      metrics: ["acwr", "monotony"],
    });
    const merged = mergeManifestForDebug(
      existing,
      [{ slug: "delta", metrics: ["monotony", "vo2max"] }],
      COORDS,
    );
    expect(merged.fixtures).toEqual(["alpha", "beta", "delta"]);
    expect(merged.metrics).toEqual(["acwr", "monotony", "vo2max"]);
  });

  it("keeps a metric the debugged fixture no longer emits (union, not replace)", () => {
    // Other fixtures may still emit it; the global metric list is a union, so
    // a single fixture dropping a metric must not prune it from the index.
    const existing = manifestWith({
      fixtures: ["alpha"],
      metrics: ["acwr", "monotony", "strain"],
    });
    const merged = mergeManifestForDebug(
      existing,
      [{ slug: "alpha", metrics: ["acwr"] }],
      COORDS,
    );
    expect(merged.metrics).toEqual(["acwr", "monotony", "strain"]);
  });

  it.each([
    ["sha", { section_11_sha: "0".repeat(40) }],
    ["protocol_version", { section_11_protocol_version: "3.999" }],
    ["commit_date", { section_11_commit_date: "1999-01-01T00:00:00+00:00" }],
    ["pyodide_version", { pyodide_version: "0.0.1" }],
  ])("throws on a %s mismatch against the current toolchain", (_field, drift) => {
    const existing = manifestWith(drift as Partial<Manifest>);
    expect(() =>
      mergeManifestForDebug(
        existing,
        [{ slug: "alpha", metrics: ["acwr"] }],
        COORDS,
      ),
    ).toThrow(/pnpm snapshot:section-11/);
  });
});

describe("loadManifestForDebugOrThrow", () => {
  function withTempDir(fn: (dir: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-manifest-test-"));
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reads and parses an existing manifest", () => {
    withTempDir((dir) => {
      const path = join(dir, "manifest.json");
      const manifest = manifestWith({});
      writeFileSync(path, JSON.stringify(manifest));
      expect(loadManifestForDebugOrThrow(path)).toEqual(manifest);
    });
  });

  it("throws instructively when no manifest exists", () => {
    withTempDir((dir) => {
      expect(() =>
        loadManifestForDebugOrThrow(join(dir, "manifest.json")),
      ).toThrow(/requires an existing manifest/);
    });
  });
});
