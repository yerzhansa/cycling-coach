// CI integrity guard for the committed real-data fixture.
//
// Why this test: the byte-stability test at
// `sanitize-cli-fixture-stability.test.ts` re-runs the CLI on the saved
// operator mock and asserts the produced bytes equal the committed fixture
// — but it skips when the mock is absent (CI machines, fresh clones).
// That leaves a gap: if the committed JSON drifts in-place (bad merge,
// editor save with different trailing-newline policy, JSON-formatter run
// against the file by mistake) the operator's byte-stability test won't
// catch it because the source mock hasn't changed.
//
// This test fills the gap. It hashes the committed fixture and compares
// to the committed `.sha256` file. CI runs it on every PR. The check is
// narrow on purpose: it doesn't verify the fixture's provenance (that's
// the operator's job via the byte-stability test) — it only verifies the
// bytes haven't been mutated since they were committed.
//
// See ADR-0013 ("Real-data fixture privacy boundary") for the policy
// context. The checksum is the integrity half of the trust seam; the
// allowlist sanitizer + operator byte-stability test is the provenance
// half.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// Every fixture with a committed `.sha256` integrity guard is checked here.
// realistic-athlete is fully sanitizer-produced; curve-equipped is a hybrid
// (sanitized rows + synthetic curve blocks); dfa-equipped is fully synthetic
// (generated stream blob). Each fixture's regen path writes the checksum
// alongside the JSON.
const FIXTURES: Array<{ slug: string; regen: string }> = [
  {
    slug: "realistic-athlete",
    regen: "tools/sanitize-fixture.ts",
  },
  {
    slug: "curve-equipped",
    regen: "tools/build-curve-fixture.ts",
  },
  {
    slug: "dfa-equipped",
    regen: "tools/build-dfa-fixture.ts",
  },
];

describe.each(FIXTURES)("$slug fixture checksum", ({ slug, regen }) => {
  it("committed fixture bytes match the committed checksum", () => {
    const fixturePath = resolve(HERE, `fixtures/golden/${slug}.json`);
    const checksumPath = resolve(HERE, `fixtures/golden/${slug}.json.sha256`);
    const bytes = readFileSync(fixturePath);
    const got = createHash("sha256").update(bytes).digest("hex");
    // `shasum -a 256 <file>` emits `<hex>  <basename>`; we want only the hex.
    const expected = readFileSync(checksumPath, "utf-8").trim().split(/\s+/)[0];
    expect(
      got,
      `Fixture bytes don't match the committed checksum.\n` +
        `Either the fixture was mutated in place (bad merge, editor save) — in which\n` +
        `case regenerate via \`${regen}\` — or the checksum is stale.\n` +
        `If you legitimately regenerated the fixture, run:\n` +
        `  (cd packages/core/tests/fixtures/golden && shasum -a 256 ${slug}.json > ${slug}.json.sha256)\n`,
    ).toBe(expected);
  });
});
