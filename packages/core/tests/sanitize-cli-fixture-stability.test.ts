// Fixture-stability guard. The committed golden at
// `tests/fixtures/golden/realistic-athlete.json` is derived from
// `docs/mocks/intervals-icu-raw-2026-05-11.json` via the sanitize CLI. If
// an operator regenerates the mock but forgets to commit the regen-ed
// golden, the two drift apart silently — metric tests then exercise a
// fixture the operator can't reproduce locally.
//
// This test runs the CLI on the saved mock to a tmpdir and compares the
// produced bytes to the committed golden. Skipped when the mock is absent
// (CI machines, fresh clones); fires loudly on the operator's machine.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../../tools/sanitize-fixture.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MOCK_PATH = join(REPO_ROOT, "docs", "mocks", "intervals-icu-raw-2026-05-11.json");
const GOLDEN_PATH = join(
  REPO_ROOT,
  "packages",
  "core",
  "tests",
  "fixtures",
  "golden",
  "realistic-athlete.json",
);

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe("sanitize CLI fixture stability", () => {
  it.skipIf(!existsSync(MOCK_PATH))(
    "running the CLI on the saved mock produces a fixture byte-identical to the committed golden",
    async () => {
      const outputDir = mkdtempSync(join(tmpdir(), "sanitize-stability-"));
      dirs.push(outputDir);

      const exit = await main([MOCK_PATH, "realistic-athlete", "--force"], {
        outputRoot: outputDir,
        // Swallow stdout/stderr — only the byte comparison matters here.
        out: () => {},
        err: () => {},
      });

      expect(exit).toBe(0);
      const regenerated = readFileSync(join(outputDir, "realistic-athlete.json"));
      const committed = readFileSync(GOLDEN_PATH);
      expect(regenerated.equals(committed)).toBe(true);
    },
  );
});
