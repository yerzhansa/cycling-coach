import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Contract gate for the section-11 snapshot harness (T06).
 *
 * Asserts that when section-11's sync.py reads a fixture field that
 * doesn't exist on the loaded JSON via `dict.get(...)`, the harness
 * fails loud with a structured error listing the missing key path
 * — instead of silently producing wrong-because-input-was-malformed
 * snapshots, which would then bit-port into the TS Reference layer.
 *
 * The complementary positive case (valid fixture → harness succeeds)
 * is covered by `snapshot-determinism.test.ts` running the harness
 * twice against the committed fixture.
 *
 * Skipped automatically when ../section-11 is not reachable.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const SECTION_11_REPO =
  process.env.SECTION_11_REPO ?? resolve(REPO_ROOT, "../section-11");
const GOLDEN_FIXTURE = resolve(
  REPO_ROOT,
  "packages/core/tests/fixtures/golden/realistic-athlete.json",
);

function section11Available(): boolean {
  try {
    statSync(join(SECTION_11_REPO, "examples/sync.py"));
    return true;
  } catch {
    return false;
  }
}

function corruptFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "snapshot-section-11-corrupt-"));
  const path = join(dir, "corrupt.json");
  const raw = JSON.parse(readFileSync(GOLDEN_FIXTURE, "utf8")) as Record<
    string,
    unknown
  >;
  // Rename the top-level "activities" key to "activitiez" — a realistic
  // single-character typo. sync.py will then read FIXTURE.activities as
  // missing, the TrackedDict will log it, and the harness must surface
  // the path.
  if (!("activities" in raw)) {
    throw new Error("golden fixture has no top-level 'activities' key");
  }
  raw["activitiez"] = raw["activities"];
  delete raw["activities"];
  writeFileSync(path, JSON.stringify(raw));
  return path;
}

function runHarness(args: { fixturePath: string; outDir: string }): {
  status: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execSync("pnpm snapshot:section-11", {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SNAPSHOT_FIXTURE_PATH: args.fixturePath,
        SNAPSHOT_OUT_DIR: args.outDir,
        SECTION_11_REPO,
      },
      stdio: "pipe",
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      status: e.status ?? -1,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
    };
  }
}

describe("section-11 snapshot harness contract validation", () => {
  it.runIf(section11Available())(
    "fails loud with the missing-key path when sync.py reads a None fixture field",
    () => {
      const corrupt = corruptFixture();
      const outDir = mkdtempSync(
        join(tmpdir(), "snapshot-section-11-corrupt-out-"),
      );

      const result = runHarness({ fixturePath: corrupt, outDir });

      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(combined).toMatch(/contract violation/i);
      // The renamed key path must be surfaced literally so a future
      // operator can find the typo without re-reading sync.py.
      expect(combined).toMatch(/FIXTURE\.activities/);
    },
    180_000,
  );
});
