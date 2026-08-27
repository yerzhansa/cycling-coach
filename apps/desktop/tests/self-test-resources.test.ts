import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { METRIC_REGISTRY } from "@enduragent/kernel/reference/registry";
import { mean, pythonSum, sampleStdev } from "@enduragent/kernel/reference/metrics";
import { deviationMap } from "../scripts/self-test-deviations.js";
import { DIFFERENTIAL_OPERATIONS } from "../src/self-test/differential.js";

const run = promisify(execFile);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const generatedRoot = join(desktopRoot, "dist");
const roots: string[] = [];
let firstGeneratedMatrix: Buffer;
let secondGeneratedMatrix: Buffer;
let canonicalGeneratedRoot: string;

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function generate(): Promise<Buffer> {
  await run(process.execPath, ["--import", "tsx", "scripts/build-self-test-resources.ts"], {
    cwd: desktopRoot,
    env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: undefined },
  });
  return readFile(join(generatedRoot, "self-test-asar/resources/self-test/matrix.json"));
}

beforeAll(async () => {
  firstGeneratedMatrix = await generate();
  secondGeneratedMatrix = await generate();
  canonicalGeneratedRoot = await mkdtemp(join(tmpdir(), "self-test-generated-"));
  roots.push(canonicalGeneratedRoot);
  await Promise.all([
    cp(join(generatedRoot, "self-test-asar"), join(canonicalGeneratedRoot, "self-test-asar"), {
      recursive: true,
    }),
    cp(join(generatedRoot, "self-test-runner"), join(canonicalGeneratedRoot, "self-test-runner"), {
      recursive: true,
    }),
    cp(join(generatedRoot, "extra-resources"), join(canonicalGeneratedRoot, "extra-resources"), {
      recursive: true,
    }),
  ]);
});

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

describe("packaged self-test resources", () => {
  it("parses approved deviation paths identically with LF and CRLF", () => {
    const source = [
      "deviations:",
      "  - metric: capability.dfa_a1_profile",
      "    added_paths:",
      "      - aet.foo",
      "    status: approved-cite",
      "",
    ].join("\n");
    const expected = [["capability.dfa_a1_profile", ["aet.foo"]]];
    expect([...deviationMap(source)]).toEqual(expected);
    expect([...deviationMap(source.replaceAll("\n", "\r\n"))]).toEqual(expected);
  });

  it("generates a deterministic complete matrix and exact public bundle", () => {
    expect(secondGeneratedMatrix.equals(firstGeneratedMatrix)).toBe(true);
    const matrix = JSON.parse(firstGeneratedMatrix.toString("utf8")) as {
      fixtures: Array<{ slug: string }>;
      parityCases: Array<{ caseId: string; fixture: string; metric: string }>;
      differentialCases: Array<{ caseId: string; fixture: string; op: string }>;
    };
    const expectedParity = matrix.fixtures
      .flatMap((fixture) =>
        Object.keys(METRIC_REGISTRY).map((metric) => `${fixture.slug}:${metric}`),
      )
      .sort();
    expect(matrix.parityCases.map((item) => item.caseId)).toEqual(expectedParity);
    expect(matrix.differentialCases.length).toBeGreaterThan(1);
    expect(
      matrix.differentialCases.some((item) =>
        matrix.parityCases.some((parity) => parity.caseId === item.caseId),
      ),
    ).toBe(false);
    const runner = require(
      join(canonicalGeneratedRoot, "self-test-runner/self-test-runner.cjs"),
    ) as unknown;
    expect(Object.keys(runner as object)).toEqual(["runSelfTest"]);
  }, 30_000);

  it("keeps the two implementations independent and exact over seeded extremes", async () => {
    const source = await readFile(join(desktopRoot, "src/self-test/differential.ts"), "utf8");
    expect(source).not.toMatch(/@enduragent\/kernel|packages\/kernel/u);
    const random = seeded(0x7e57_cafe);
    const first = { pythonSum, mean, sampleStdev } as const;
    for (let caseIndex = 0; caseIndex < 1_000; caseIndex += 1) {
      const lengths = [8, 9, 31, 128, 257];
      const length = lengths[caseIndex % lengths.length]!;
      const values = Array.from({ length }, (_, index) => {
        const sign = random() < 0.5 ? -1 : 1;
        if (caseIndex % 4 === 0) return sign * random() * 1_000_000;
        if (caseIndex % 4 === 1) return sign * Number.MIN_VALUE * (1 + Math.floor(random() * 1024));
        if (caseIndex % 4 === 2) return sign * (index % 2 === 0 ? 1e200 : 1e-200) * random();
        return sign * 2 ** (Math.floor(random() * 1_800) - 900) * random();
      });
      for (const operation of Object.keys(DIFFERENTIAL_OPERATIONS) as Array<
        keyof typeof DIFFERENTIAL_OPERATIONS
      >) {
        expect(
          Object.is(first[operation](values), DIFFERENTIAL_OPERATIONS[operation](values)),
        ).toBe(true);
      }
    }
  }, 180_000);

  it("stages disjoint byte-identical resources and preserves builder inputs", async () => {
    const [insideMatrix, outsideMatrix, insideChecksum, outsideChecksum, builder, bundle] =
      await Promise.all([
        readFile(join(canonicalGeneratedRoot, "self-test-asar/resources/self-test/matrix.json")),
        readFile(join(canonicalGeneratedRoot, "extra-resources/self-test/matrix.json")),
        readFile(join(canonicalGeneratedRoot, "self-test-asar/resources/self-test/matrix.sha256")),
        readFile(join(canonicalGeneratedRoot, "extra-resources/self-test/matrix.sha256")),
        readFile(join(desktopRoot, "electron-builder.yml"), "utf8"),
        readFile(
          join(canonicalGeneratedRoot, "extra-resources/self-test/self-test-runner.cjs"),
          "utf8",
        ),
      ]);
    expect(outsideMatrix.equals(insideMatrix)).toBe(true);
    expect(outsideChecksum.equals(insideChecksum)).toBe(true);
    expect(builder).toContain("from: dist/self-test-asar\n    to: .");
    expect(builder).toContain("from: dist/extra-resources");
    expect(bundle).not.toMatch(/vitest|process\.exit|process\.exitCode|console\./iu);
    const root = await mkdtemp(join(tmpdir(), "self-test-layout-"));
    roots.push(root);
    await cp(join(canonicalGeneratedRoot, "self-test-asar"), join(root, "app.asar"), {
      recursive: true,
    });
    await cp(join(canonicalGeneratedRoot, "extra-resources/self-test"), join(root, "self-test"), {
      recursive: true,
    });
    const loaded = require(
      join(canonicalGeneratedRoot, "self-test-runner/self-test-runner.cjs"),
    ) as {
      runSelfTest(input: { resourcesPath: string }): { ok: boolean };
    };
    expect(loaded.runSelfTest({ resourcesPath: root }).ok).toBe(true);
  }, 30_000);

  it.each([
    ["asar", "matrix.json", "app.asar/resources/self-test/matrix.json"],
    ["extraResources", "matrix.json", "self-test/matrix.json"],
    ["asar", "matrix.sha256", "app.asar/resources/self-test/matrix.sha256"],
    ["extraResources", "matrix.sha256", "self-test/matrix.sha256"],
  ] as const)(
    "classifies %s %s corruption",
    async (location, resource, relativePath) => {
      const root = await mkdtemp(join(tmpdir(), "self-test-corruption-"));
      roots.push(root);
      await cp(join(canonicalGeneratedRoot, "self-test-asar"), join(root, "app.asar"), {
        recursive: true,
      });
      await cp(join(canonicalGeneratedRoot, "extra-resources/self-test"), join(root, "self-test"), {
        recursive: true,
      });
      const target = join(root, relativePath);
      const bytes = await readFile(target);
      bytes[0] = bytes[0] === 97 ? 98 : 97;
      await writeFile(target, bytes);
      const loaded = require(
        join(canonicalGeneratedRoot, "self-test-runner/self-test-runner.cjs"),
      ) as {
        runSelfTest(input: { resourcesPath: string }): unknown;
      };
      expect(loaded.runSelfTest({ resourcesPath: root })).toMatchObject({
        ok: false,
        error: {
          code: "CHECKSUM_MISMATCH",
          location,
          resource,
          expectedSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          actualSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
    },
    30_000,
  );

  it("keeps generated artifacts outside tracked source", async () => {
    try {
      await lstat(join(repositoryRoot, ".git"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const ignoreRules = await readFile(join(repositoryRoot, ".gitignore"), "utf8");
      expect(ignoreRules.split(/\r?\n/u)).toContain("dist/");
      return;
    }
    const ignore = await run("git", ["check-ignore", "apps/desktop/dist/self-test-asar"], {
      cwd: repositoryRoot,
    });
    expect(ignore.stdout.trim()).toBe("apps/desktop/dist/self-test-asar");
  });
});
