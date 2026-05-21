import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  DOI_OR_PMID_REGEX,
  RESEARCH_FILE_MIN_WORDS,
  loadDeviationRegistry,
  validateResearchFile,
} from "../../../tools/check-metric-parity";

/**
 * Cite-path stress test for the parity gate's research-file content
 * validation (T04 §research-file content validation).
 *
 * Until a real `approved-cite` deviation lands, the cite-path of the
 * porting discipline has zero runs against real machinery — that's
 * the load-bearing risk surfaced by `/architect`'s 2026-05-21
 * review. This file synthesizes the four states the cite enforcement
 * has to handle and asserts each one drives the validator to the
 * expected outcome:
 *
 *   1. File missing → reject.
 *   2. File present but no DOI/PMID → reject.
 *   3. File present, has DOI, but < 300 words → reject.
 *   4. File present, has DOI, ≥ 300 words → accept.
 *
 * Each case writes a tempdir file at the path the validator resolves
 * against (via the validator's REPO_ROOT-relative resolution). We
 * pass the absolute path via the same `justification.path` field
 * the registry uses, but rooted under `tmpdir()` for isolation.
 */

function workspaceRelative(absPath: string): string {
  // The validator resolves justification.path against REPO_ROOT.
  // Passing an absolute path under tmpdir bypasses that (resolve(REPO_ROOT, abs) === abs).
  return absPath;
}

describe("cite-path enforcement — synthetic stress test", () => {
  it("rejects when the file is missing", () => {
    const r = validateResearchFile(
      workspaceRelative(join(tmpdir(), "definitely-not-a-real-file.md")),
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/file does not exist/);
  });

  it("rejects when the file lacks any DOI or PMID marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "cite-path-no-doi-"));
    const path = join(dir, "research.md");
    writeFileSync(
      path,
      "Lorem ipsum ".repeat(80), // ≥ 300 words, but no DOI/PMID
    );
    const r = validateResearchFile(workspaceRelative(path));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/no DOI or PMID marker/);
  });

  it("rejects when the file has DOI but is under the word minimum", () => {
    const dir = mkdtempSync(join(tmpdir(), "cite-path-thin-"));
    const path = join(dir, "research.md");
    // Has DOI, ~10 words total.
    writeFileSync(path, "Short citation, DOI: 10.1234/example.2020.001 — nothing more.\n");
    const r = validateResearchFile(workspaceRelative(path));
    expect(r.ok).toBe(false);
    expect(r.reasons.join("\n")).toMatch(/word count.*below.*300-word minimum/);
  });

  it("accepts when the file has DOI and ≥ 300 words", () => {
    const dir = mkdtempSync(join(tmpdir(), "cite-path-ok-"));
    const path = join(dir, "research.md");
    const body =
      "Foo bar baz ".repeat(120) + // 360 words
      "\n\nDOI: 10.5678/example.2021.042\n";
    writeFileSync(path, body);
    const r = validateResearchFile(workspaceRelative(path));
    expect(r.ok).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("accepts PMID markers equivalently to DOI markers", () => {
    const dir = mkdtempSync(join(tmpdir(), "cite-path-pmid-"));
    const path = join(dir, "research.md");
    const body = "Foo bar baz ".repeat(120) + "\n\nPMID: 12345678\n";
    writeFileSync(path, body);
    const r = validateResearchFile(workspaceRelative(path));
    expect(r.ok).toBe(true);
  });

  it("pins the configured minimum word count and marker regex", () => {
    // Future drift on these constants must be intentional — bump
    // both constants and this test together.
    expect(RESEARCH_FILE_MIN_WORDS).toBe(300);
    expect(DOI_OR_PMID_REGEX.test("nothing here")).toBe(false);
    expect(DOI_OR_PMID_REGEX.test("10.1234/abc")).toBe(true);
    expect(DOI_OR_PMID_REGEX.test("PMID: 99")).toBe(false); // ≤ 2 digits
    expect(DOI_OR_PMID_REGEX.test("PMID: 999")).toBe(true);
  });
});

describe("cite-path enforcement — registry-referenced research files", () => {
  // The contract is "every research file cited from an approved-cite
  // entry in tools/intentional-deviations.yaml passes the validator."
  // Currently 0 approved-cite entries (all three F8 deviations were
  // reverted), so this block is structurally a no-op — but the moment
  // someone flips an entry to `approved-cite` with a justification
  // path, this loop pins the file to the discipline's evidential
  // standard without requiring a test edit.
  it("every approved-cite entry resolves a research file that passes validation", () => {
    const registry = loadDeviationRegistry();
    const cites = registry.deviations.filter((d) => d.status === "approved-cite");
    for (const entry of cites) {
      const path = entry.justification?.path;
      expect(path, `${entry.metric} is approved-cite but has no justification.path`).toBeTruthy();
      const r = validateResearchFile(path);
      expect(
        r.ok,
        `${entry.metric} → ${path} failed cite-path validation: ${r.reasons.join("; ")}`,
      ).toBe(true);
    }
  });
});
