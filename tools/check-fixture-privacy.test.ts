// fixture-privacy-lint:skip-file — this test embeds the forbidden id shape and
// current-era dates in synthetic fixtures and assertions; it would always flag
// itself otherwise.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findIdHits, findDateHits, main, type PrivacyHit } from "./check-fixture-privacy.js";

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "fixture-privacy-lint-"));
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

describe("Rule A — real intervals.icu id shape", () => {
  it("flags an i+9-digit id inside a JSON string", () => {
    const file = write("fixture.json", `{ "id": "i123456789", "type": "Ride" }\n`);
    const hits = findIdHits([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe("intervals-id");
    expect(hits[0].detail).toContain("i123456789");
  });

  it("flags an i+8-digit id inside a TS string literal", () => {
    const file = write("sample.ts", `export const id = "i14662260";\n`);
    const hits = findIdHits([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe("intervals-id");
  });

  it("flags an i+8-9-digit id inside a TS comment", () => {
    const file = write("comment.ts", `// real id looks like i987654321\nconst x = 1;\n`);
    const hits = findIdHits([file]);
    expect(hits).toHaveLength(1);
  });

  it("passes short synthetic placeholders below the shape (i1, i9876543)", () => {
    const file = write("ok.json", `{ "a": "i1", "b": "i2", "c": "i9876543" }\n`);
    expect(findIdHits([file])).toHaveLength(0);
  });

  it("passes the documented 8-digit synthetic placeholders in the allowlist", () => {
    const file = write("ok.json", `{ "a": "i12345678", "b": "i12345679" }\n`);
    expect(findIdHits([file])).toHaveLength(0);
  });

  it("respects the skip-file marker (suppresses Rule A)", () => {
    const file = write(
      "skipped.ts",
      `// fixture-privacy-lint:skip-file\nexport const id = "i123456789";\n`,
    );
    expect(findIdHits([file])).toHaveLength(0);
  });
});

describe("Rule B — current-era dates in real-data golden fixtures", () => {
  it("flags a 2026 date inside a non-synthetic golden fixture", () => {
    const file = write(
      "realistic-athlete.json",
      `{ "activities": [{ "start_date_local": "2026-05-09T07:00:00" }] }\n`,
    );
    const hits = findDateHits([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe("current-era-date");
    expect(hits[0].detail).toContain("2026");
  });

  it("flags a current-era date used as an object key", () => {
    const file = write("curve-equipped.json", `{ "streams": { "2026-05-09": 1 } }\n`);
    const hits = findDateHits([file]);
    expect(hits).toHaveLength(1);
    expect(hits[0].detail).toContain("<key:2026-05-09>");
  });

  it("passes a shifted (1998) date", () => {
    const file = write(
      "realistic-athlete.json",
      `{ "activities": [{ "start_date_local": "1998-05-09T07:00:00" }] }\n`,
    );
    expect(findDateHits([file])).toHaveLength(0);
  });

  it("exempts fully-synthetic golden fixtures by basename", () => {
    const file = write(
      "dfa-equipped.json",
      `{ "activities": [{ "start_date_local": "2026-05-28T07:00:00" }] }\n`,
    );
    expect(findDateHits([file])).toHaveLength(0);
  });

  it("respects the skip-file marker (suppresses Rule B)", () => {
    const file = write(
      "realistic-athlete.json",
      `{ "_comment": "fixture-privacy-lint:skip-file", "d": "2026-05-09" }\n`,
    );
    expect(findDateHits([file])).toHaveLength(0);
  });
});

describe("default scan paths — GitHub-visible surfaces", () => {
  const coveredPaths = [
    ".changeset/sneaky-change.md",
    "README.md",
    "CONTRIBUTING.md",
    "CONTEXT-MAP.md",
    "NOTICE.md",
  ];

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

  it("flags a real-shaped id planted under each newly covered default path", () => {
    for (const rel of coveredPaths) {
      write(rel, `prose mentioning the id i123456789 outside any code fence\n`);
    }
    process.chdir(tempDir);
    expect(main([])).toBe(1);
    const output = errSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    for (const rel of coveredPaths) {
      expect(output).toContain(rel);
    }
  });

  it("scans the dot-named .changeset directory when given as a top-level path", () => {
    write(".changeset/leak.md", `id i987654321 in a changeset\n`);
    process.chdir(tempDir);
    expect(main([])).toBe(1);
    const output = errSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(output).toContain(join(".changeset", "leak.md"));
  });

  it("returns 0 when the default surfaces are clean", () => {
    for (const rel of coveredPaths) {
      write(rel, "nothing id-shaped here\n");
    }
    process.chdir(tempDir);
    expect(main([])).toBe(0);
  });
});

describe("hit shape", () => {
  it("carries file/rule/detail on every hit", () => {
    const idFile = write("a.json", `{ "id": "i123456789" }\n`);
    const dateFile = write("realistic-athlete.json", `{ "d": "2026-01-01" }\n`);
    const hits: PrivacyHit[] = [...findIdHits([idFile]), ...findDateHits([dateFile])];
    for (const h of hits) {
      expect(h.file).toBeTruthy();
      expect(["intervals-id", "current-era-date"]).toContain(h.rule);
      expect(h.detail.length).toBeGreaterThan(0);
    }
  });
});
