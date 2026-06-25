// changeset-userfacing-lint:skip-file — this test embeds sample changeset
// bodies with `User-facing:` lines and sample package names as fixtures; the
// marker keeps it uniform with the sibling gates' tests.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findChangesetHits,
  discoverPublishedBinaries,
  main,
  type ChangesetHit,
} from "./check-changeset-user-facing.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "changeset-userfacing-lint-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function write(rel: string, contents: string): string {
  const p = join(tempDir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, contents, "utf-8");
  return p;
}

/**
 * Lay down a `packages/` tree mirroring the real repo's published-binary state:
 * `cycling-coach` (bin + public) is the only published binary; the sport and
 * core packages are private. Returns the absolute `packages/` dir path to pass
 * as the gate's `packagesDir`.
 */
function writeRealisticPackages(): string {
  write(
    "packages/cycling-coach/package.json",
    JSON.stringify({ name: "cycling-coach", bin: { "cycling-coach": "dist/index.js" } }),
  );
  write(
    "packages/core/package.json",
    JSON.stringify({ name: "@enduragent/core", private: true }),
  );
  write(
    "packages/running-coach/package.json",
    JSON.stringify({ name: "running-coach", bin: { "running-coach": "dist/index.js" }, private: true }),
  );
  write(
    "packages/sport-cycling/package.json",
    JSON.stringify({ name: "@enduragent/sport-cycling", private: true }),
  );
  return join(tempDir, "packages");
}

describe("discoverPublishedBinaries", () => {
  it("returns only bin+public packages, keyed by npm name", () => {
    const pkgsDir = writeRealisticPackages();
    const set = discoverPublishedBinaries(pkgsDir);
    expect([...set]).toEqual(["cycling-coach"]);
  });

  it("auto-extends when a private binary drops its private flag", () => {
    const pkgsDir = writeRealisticPackages();
    // running-coach starts private; rewrite it as public.
    write(
      "packages/running-coach/package.json",
      JSON.stringify({ name: "running-coach", bin: { "running-coach": "dist/index.js" } }),
    );
    const set = discoverPublishedBinaries(pkgsDir);
    expect([...set].sort()).toEqual(["cycling-coach", "running-coach"]);
  });

  it("auto-removes the published binary when it is marked private", () => {
    const pkgsDir = writeRealisticPackages();
    write(
      "packages/cycling-coach/package.json",
      JSON.stringify({ name: "cycling-coach", bin: { "cycling-coach": "dist/index.js" }, private: true }),
    );
    const set = discoverPublishedBinaries(pkgsDir);
    expect([...set]).toEqual([]);
  });

  it("treats a missing private field as public and an empty bin object as no bin", () => {
    const pkgsDir = writeRealisticPackages();
    write(
      "packages/empty-bin/package.json",
      JSON.stringify({ name: "empty-bin", bin: {} }),
    );
    write(
      "packages/string-bin/package.json",
      JSON.stringify({ name: "string-bin", bin: "dist/cli.js" }),
    );
    const set = discoverPublishedBinaries(pkgsDir);
    expect([...set].sort()).toEqual(["cycling-coach", "string-bin"]);
  });

  it("skips unparseable manifests without crashing", () => {
    const pkgsDir = writeRealisticPackages();
    write("packages/broken/package.json", "{ not valid json ");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const set = discoverPublishedBinaries(pkgsDir);
    expect([...set]).toEqual(["cycling-coach"]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns an empty set when the packages dir does not exist", () => {
    expect([...discoverPublishedBinaries(join(tempDir, "nope"))]).toEqual([]);
  });
});

describe("findChangesetHits — User-facing routing", () => {
  it("PASS: a User-facing changeset that names the published binary", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/good.md",
      `---\n"cycling-coach": patch\n---\n\nUser-facing: Added /review command.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });

  it("FAIL: a User-facing changeset that names only the private core package", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/bad.md",
      `---\n"@enduragent/core": patch\n---\n\nUser-facing: Fixed a sync bug athletes will notice.\n`,
    );
    const hits = findChangesetHits([file], pkgsDir);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ file, namedPackages: ["@enduragent/core"] });
    expect(hits[0].line).toBeGreaterThan(0);
    expect(hits[0].column).toBeGreaterThan(0);
  });

  it("PASS (ignored): a changeset with no User-facing line, even if private-only", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/infra.md",
      `---\n"@enduragent/core": patch\n---\n\nRefactored the retry helper. Pure infra.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });

  it("PASS: names a private sport package AND the published binary", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/multi.md",
      `---\n"@enduragent/sport-cycling": patch\n"cycling-coach": patch\n---\n\nUser-facing: New zone vocabulary.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });

  it("FAIL: names only a private sport package", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/sport-only.md",
      `---\n"@enduragent/sport-cycling": minor\n---\n\nUser-facing: New zone vocabulary athletes see.\n`,
    );
    const hits = findChangesetHits([file], pkgsDir);
    expect(hits).toHaveLength(1);
    expect(hits[0].namedPackages).toEqual(["@enduragent/sport-cycling"]);
  });

  it("handles multiple User-facing lines (single hit, still flags misfiled)", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/many.md",
      `---\n"@enduragent/core": patch\n---\n\nUser-facing: First athlete-visible change.\nUser-facing: Second athlete-visible change.\n`,
    );
    const hits = findChangesetHits([file], pkgsDir);
    expect(hits).toHaveLength(1);
  });

  it("is case-insensitive on the `user-facing:` marker", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/lower.md",
      `---\n"@enduragent/core": patch\n---\n\nuser-facing: lowercase marker still counts.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toHaveLength(1);
  });

  it("does NOT treat a User-facing line in the FRONTMATTER as a body marker", () => {
    // A `User-facing:` that lands inside the frontmatter fence (malformed, but
    // possible) is not a body line; with no body marker there is no violation.
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/in-frontmatter.md",
      `---\n"@enduragent/core": patch\nUser-facing: stray\n---\n\nNo body marker here.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });
});

describe("findChangesetHits — marker forms the consumer renders (escape-hole regression)", () => {
  // `parseUserFacing` in packages/core/src/release-notes.ts matches `User-facing:`
  // UNANCHORED, so the published release body /whatsnew reads renders the marker
  // even when it is written as a markdown bullet or otherwise indented. An
  // anchored gate regex would miss these and let a misfiling reach athletes;
  // these pin the gate's detector to the consumer's breadth.
  it("FAIL: bullet `- User-facing:` filed against core only (was an escape hole)", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/bullet.md",
      `---\n"@enduragent/core": patch\n---\n\n- User-facing: athlete-visible, written as a bullet.\n`,
    );
    const hits = findChangesetHits([file], pkgsDir);
    expect(hits).toHaveLength(1);
    // Location points at the body line (source line 5), not the frontmatter.
    expect(hits[0].line).toBe(5);
  });

  it("FAIL: indented `  User-facing:` filed against core only", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/indented.md",
      `---\n"@enduragent/core": patch\n---\n\n  User-facing: indented marker still reaches athletes.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toHaveLength(1);
  });

  it("FAIL: CRLF body with a User-facing marker filed against core only", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/crlf.md",
      `---\r\n"@enduragent/core": patch\r\n---\r\n\r\nUser-facing: CRLF line endings still detected.\r\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toHaveLength(1);
  });

  it("PASS: bullet `- User-facing:` correctly filed against the published binary", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/bullet-good.md",
      `---\n"cycling-coach": patch\n---\n\n- User-facing: bullet form, correctly filed.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });

  it("PASS (not over-flagged): `User-facing :` with a space before the colon — the consumer ignores it, so the gate must too", () => {
    // parseUserFacing requires the colon immediately after `facing`; a
    // space-before-colon form is never rendered to athletes, so it is not a
    // misfiling the gate should flag (avoids a false positive).
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/space-before-colon.md",
      `---\n"@enduragent/core": patch\n---\n\nUser-facing : has a stray space, not a real marker.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });
});

describe("findChangesetHits — non-changeset files and skip marker", () => {
  it("ignores .changeset/README.md", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/README.md",
      `# Changesets\n\nUser-facing: this is documentation, not a changeset.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });

  it("ignores config.json (not an .md, never collected as a changeset)", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(".changeset/config.json", `{ "changelog": "@changesets/cli/changelog" }`);
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });

  it("respects the skip-file marker", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/skipme.md",
      `<!-- changeset-userfacing-lint:skip-file -->\n---\n"@enduragent/core": patch\n---\n\nUser-facing: exempted by marker.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });

  it("does NOT skip when the marker appears past the 1 KB header window", () => {
    const pkgsDir = writeRealisticPackages();
    const filler = "x".repeat(1100);
    const file = write(
      ".changeset/late.md",
      `---\n"@enduragent/core": patch\n---\n\n${filler}\n<!-- changeset-userfacing-lint:skip-file -->\nUser-facing: late marker does not exempt.\n`,
    );
    expect(findChangesetHits([file], pkgsDir)).toHaveLength(1);
  });

  it("ignores files with unsupported extensions", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(".changeset/notes.txt", `User-facing: not a markdown changeset.\n`);
    expect(findChangesetHits([file], pkgsDir)).toEqual([]);
  });
});

describe("main — CLI entrypoint over the default scope", () => {
  let originalCwd: string;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("returns 1 and names the offending changeset on a misfiled User-facing line", () => {
    writeRealisticPackages();
    write(
      ".changeset/bad.md",
      `---\n"@enduragent/core": patch\n---\n\nUser-facing: athlete-visible, misfiled.\n`,
    );
    process.chdir(tempDir);
    expect(main([])).toBe(1);
    const output = errSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(output).toContain(join(".changeset", "bad.md"));
  });

  it("returns 0 when every User-facing changeset names the published binary", () => {
    writeRealisticPackages();
    write(
      ".changeset/good.md",
      `---\n"cycling-coach": patch\n---\n\nUser-facing: athlete-visible, correctly filed.\n`,
    );
    process.chdir(tempDir);
    expect(main([])).toBe(0);
  });

  it("returns 0 with an empty-scope message when there are no changesets", () => {
    writeRealisticPackages();
    write(".changeset/config.json", `{ "x": 1 }`);
    write(".changeset/README.md", `# docs`);
    process.chdir(tempDir);
    // README.md is collected (it's .md) but ignored as a non-changeset; it is
    // still in scope as a file, so this exercises the clean-output path.
    expect(main([])).toBe(0);
  });
});

describe("hit shape", () => {
  it("carries file/line/column/namedPackages on every hit", () => {
    const pkgsDir = writeRealisticPackages();
    const file = write(
      ".changeset/bad.md",
      `---\n"@enduragent/core": patch\n"@enduragent/sport-running": patch\n---\n\nUser-facing: misfiled change.\n`,
    );
    const hits: ChangesetHit[] = findChangesetHits([file], pkgsDir);
    for (const h of hits) {
      expect(h.file).toBeTruthy();
      expect(h.line).toBeGreaterThan(0);
      expect(h.column).toBeGreaterThan(0);
      expect(h.namedPackages.length).toBeGreaterThan(0);
    }
  });
});
