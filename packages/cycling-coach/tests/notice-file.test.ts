import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootNotice = fileURLToPath(new URL("../../../NOTICE.md", import.meta.url));
const packageNotice = fileURLToPath(new URL("../NOTICE.md", import.meta.url));
const packageJson = fileURLToPath(new URL("../package.json", import.meta.url));

describe("cycling-coach NOTICE.md", () => {
  it("is byte-identical to the root NOTICE.md (the copy cannot silently drift)", () => {
    expect(readFileSync(packageNotice).equals(readFileSync(rootNotice))).toBe(true);
  });

  it("is listed in the published tarball's files array", () => {
    const pkg = JSON.parse(readFileSync(packageJson, "utf-8")) as { files: string[] };
    expect(pkg.files).toContain("NOTICE.md");
  });
});
