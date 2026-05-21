import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Determinism gate for the section-11 snapshot harness.
 *
 * Runs `pnpm snapshot:section-11` twice into separate temp dirs and
 * asserts the two trees are byte-identical. If this test fails, the
 * harness has acquired a non-determinism source — see the
 * "Determinism" section in tools/snapshot-section-11.README.md for
 * the audited list and the rule for adding to it.
 *
 * The test is skipped automatically when `../section-11` is not
 * available (e.g., on CI without the section-11 checkout). Pin
 * SECTION_11_REPO to a valid path to run.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const SECTION_11_REPO =
  process.env.SECTION_11_REPO ?? resolve(REPO_ROOT, "../section-11");

function section11Available(): boolean {
  try {
    statSync(join(SECTION_11_REPO, "examples/sync.py"));
    return true;
  } catch {
    return false;
  }
}

function runHarness(outDir: string): void {
  execSync("pnpm snapshot:section-11", {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SNAPSHOT_OUT_DIR: outDir,
      SECTION_11_REPO,
    },
    stdio: "pipe",
  });
}

function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(root, rel);
    for (const entry of readdirSync(abs)) {
      const next = rel ? `${rel}/${entry}` : entry;
      const s = statSync(join(root, next));
      if (s.isDirectory()) {
        walk(next);
      } else {
        out.push(next);
      }
    }
  };
  walk("");
  out.sort();
  return out;
}

describe("section-11 snapshot harness determinism", () => {
  it.runIf(section11Available())(
    "two consecutive runs produce byte-identical output trees",
    () => {
      const dir1 = mkdtempSync(join(tmpdir(), "snapshot-section-11-run-1-"));
      const dir2 = mkdtempSync(join(tmpdir(), "snapshot-section-11-run-2-"));

      runHarness(dir1);
      runHarness(dir2);

      const files1 = listFilesRecursive(dir1);
      const files2 = listFilesRecursive(dir2);
      expect(files2).toEqual(files1);

      for (const rel of files1) {
        const a = readFileSync(join(dir1, rel));
        const b = readFileSync(join(dir2, rel));
        expect(
          a.equals(b),
          `byte-mismatch in ${rel} — see Determinism section of tools/snapshot-section-11.README.md`,
        ).toBe(true);
      }
    },
    180_000,
  );
});
