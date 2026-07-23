import { describe, expect, it } from "vitest";

import {
  main,
  nextCalVer,
  parseCalVer,
  parseRegistryVersions,
  planBinaryVersionBump,
  rewriteFirstChangelogHeader,
  runCli,
} from "./bump-binaries-to-calver.js";

function isStandardSemVerGreater(candidate: string, occupied: string): boolean {
  const parse = (version: string) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
    if (match === null) throw new Error(`Invalid test SemVer: ${version}`);
    return {
      core: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4],
    };
  };
  const left = parse(candidate);
  const right = parse(occupied);
  for (let index = 0; index < left.core.length; index++) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index];
    }
  }
  return left.prerelease === undefined && right.prerelease !== undefined;
}

describe("CalVer parsing", () => {
  it("accepts stable and historical versions but rejects malformed calendar versions", () => {
    expect(parseCalVer("2026.7.2")).toMatchObject({
      year: 2026,
      month: 7,
      patch: 2,
      legacyRevision: 0,
    });
    expect(parseCalVer("2026.6.25-1")).toMatchObject({
      year: 2026,
      month: 6,
      patch: 25,
      legacyRevision: 1,
    });
    expect(parseCalVer("2026.13.0")).toBeNull();
    expect(parseCalVer("2026.07.0")).toBeNull();
    expect(parseCalVer("not-a-version")).toBeNull();
  });

  it("validates every version in registry JSON", () => {
    expect(parseRegistryVersions('["0.0.1","2026.6.25-1","2026.7.2"]')).toEqual([
      "2026.6.25-1",
      "2026.7.2",
    ]);
    expect(() => parseRegistryVersions("{")).toThrow(/registry JSON/i);
    expect(() => parseRegistryVersions('["2026.7.2","broken"]')).toThrow(/registry version/i);
    expect(() => parseRegistryVersions('{"version":"2026.7.2"}')).toThrow(/array/i);
  });
});

describe("nextCalVer", () => {
  it("increments stable releases monotonically within the current UTC month", () => {
    const now = new Date("2026-07-31T23:59:59.000Z");
    const third = nextCalVer(["2026.7.2"], now);
    const fourth = nextCalVer(["2026.7.2", third], now);

    expect(third).toBe("2026.7.3");
    expect(fourth).toBe("2026.7.4");
    expect(third).not.toContain("-");
    expect(fourth).not.toContain("-");
  });

  it("treats a historical suffix as occupancy and emits the next stable patch", () => {
    const occupied = ["2026.6.25", "2026.6.25-1"];
    const next = nextCalVer(occupied, new Date("2026-06-26T00:00:00.000Z"));

    expect(next).toBe("2026.6.26");
    expect(occupied.every((version) => isStandardSemVerGreater(next, version))).toBe(true);
  });

  it("resets to patch zero after a UTC month or year rollover", () => {
    expect(nextCalVer(["2026.6.25"], new Date("2026-07-31T23:59:59.000Z"))).toBe("2026.7.0");
    expect(nextCalVer(["2026.12.9"], new Date("2027-01-01T00:00:00.000Z"))).toBe("2027.1.0");
  });

  it("uses the UTC month when the local offset has already crossed midnight", () => {
    expect(nextCalVer(["2026.7.2"], new Date("2026-08-01T00:30:00+05:00"))).toBe("2026.7.3");
  });

  it("fails when the UTC clock is behind occupancy or the patch would overflow", () => {
    expect(() => nextCalVer(["2026.8.0"], new Date("2026-07-31T23:59:59.000Z"))).toThrow(
      /precedes occupied version/i,
    );
    expect(() =>
      nextCalVer([`2026.7.${Number.MAX_SAFE_INTEGER}`], new Date("2026-07-31T23:59:59.000Z")),
    ).toThrow(/overflow/i);
  });
});

describe("planBinaryVersionBump", () => {
  it("advances from the committed version when the repository is ahead of npm", () => {
    const plan = planBinaryVersionBump({
      packageName: "cycling-coach",
      packageJsonPath: "packages/cycling-coach/package.json",
      changelogPath: "packages/cycling-coach/CHANGELOG.md",
      packageJsonContents: JSON.stringify({ name: "cycling-coach", version: "2026.8.0" }),
      committedPackageJsonContents: JSON.stringify({
        name: "cycling-coach",
        version: "2026.7.4",
      }),
      registryVersionsJson: '["2026.7.1","2026.7.2"]',
      changelogContents: "# cycling-coach\n\n## 2026.8.0\n\nNew release.\n",
      now: new Date("2026-07-23T12:00:00.000Z"),
    });

    expect(plan.oldVersion).toBe("2026.8.0");
    expect(plan.committedVersion).toBe("2026.7.4");
    expect(plan.newVersion).toBe("2026.7.5");
    expect(JSON.parse(plan.packageJsonContents).version).toBe("2026.7.5");
    expect(plan.changelogContents).toContain("## 2026.7.5");
  });

  it("rewrites only the first exact matching changelog header", () => {
    const original =
      "# cycling-coach\n\n## 2026.8.0\n\nCurrent.\n\n## 2026.8.0\n\nHistorical duplicate.\n";
    const rewritten = rewriteFirstChangelogHeader(original, "2026.8.0", "2026.7.3");

    expect(rewritten.changed).toBe(true);
    expect(rewritten.contents).toBe(
      "# cycling-coach\n\n## 2026.7.3\n\nCurrent.\n\n## 2026.8.0\n\nHistorical duplicate.\n",
    );
  });

  it("never rewrites a later historical header when the top release differs", () => {
    const original = "# cycling-coach\n\n## 2026.8.1\n\nCurrent.\n\n## 2026.8.0\n\nHistorical.\n";

    expect(rewriteFirstChangelogHeader(original, "2026.8.0", "2026.7.3")).toEqual({
      contents: original,
      changed: false,
    });
    expect(
      rewriteFirstChangelogHeader(
        "# cycling-coach\n\n## 2026.8.00\n\nDifferent release.\n",
        "2026.8.0",
        "2026.7.3",
      ),
    ).toMatchObject({ changed: false });
  });

  it("requires the top changelog release to match both the working and planned versions", () => {
    const base = {
      packageName: "cycling-coach",
      packageJsonPath: "packages/cycling-coach/package.json",
      changelogPath: "packages/cycling-coach/CHANGELOG.md",
      packageJsonContents: JSON.stringify({ name: "cycling-coach", version: "2026.7.3" }),
      committedPackageJsonContents: JSON.stringify({
        name: "cycling-coach",
        version: "2026.7.2",
      }),
      registryVersionsJson: '["0.0.1","2026.7.2"]',
      now: new Date("2026-07-23T12:00:00.000Z"),
    };

    expect(() =>
      planBinaryVersionBump({
        ...base,
        changelogContents: "# cycling-coach\n\n## 2026.7.2\n\nStale.\n",
      }),
    ).toThrow(/top release header is inconsistent/i);
    expect(() => planBinaryVersionBump(base)).toThrow(/CHANGELOG\.md is required/i);
    expect(
      planBinaryVersionBump({
        ...base,
        changelogContents: "# cycling-coach\n\n## 2026.7.3\n\nCurrent.\n",
      }),
    ).toMatchObject({
      packageChanged: false,
      changelogChanged: false,
      newVersion: "2026.7.3",
    });
  });
});

interface CommandCall {
  readonly command: string;
  readonly args: readonly string[];
}

interface DependencyFixtureOptions {
  readonly workingVersions?: Readonly<Record<string, string>>;
  readonly committedVersions?: Readonly<Record<string, string>>;
  readonly registryResults?: Readonly<Record<string, string>>;
  readonly changelogVersions?: Readonly<Record<string, string>>;
  readonly missingChangelogs?: readonly string[];
  readonly commandErrors?: Readonly<Record<string, Error>>;
}

function dependencyFixture(options: DependencyFixtureOptions = {}) {
  const writes: Array<{ path: string; contents: string }> = [];
  const commandCalls: CommandCall[] = [];
  const committedVersions = options.committedVersions ?? {
    "cycling-coach": "2026.7.2",
  };
  const registryResults = options.registryResults ?? {
    "cycling-coach": '["2026.6.25-1","2026.7.2"]',
  };

  return {
    writes,
    commandCalls,
    dependencies: {
      execFileSync(command: string, args: readonly string[]): string {
        commandCalls.push({ command, args: [...args] });
        const packageName =
          command === "git"
            ? args[1]?.match(/^HEAD:packages\/([^/]+)\/package\.json$/)?.[1]
            : args[1];
        if (packageName === undefined) throw new Error("Unexpected command arguments");
        const commandError = options.commandErrors?.[`${command}:${packageName}`];
        if (commandError !== undefined) throw commandError;
        if (command === "git") {
          const version = committedVersions[packageName];
          if (version === undefined) throw new Error(`No committed fixture for ${packageName}`);
          return JSON.stringify({ name: packageName, version });
        }
        if (command === "npm") {
          const result = registryResults[packageName];
          if (result === undefined) throw new Error(`No registry fixture for ${packageName}`);
          return result;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      readFileSync(path: string): string {
        const packageName = path.match(
          /\/packages\/([^/]+)\/(?:package\.json|CHANGELOG\.md)$/,
        )?.[1];
        if (packageName === undefined) throw new Error(`Unexpected read: ${path}`);
        const version = options.workingVersions?.[packageName] ?? "2026.8.0";
        if (path.endsWith("/CHANGELOG.md")) {
          const changelogVersion = options.changelogVersions?.[packageName] ?? version;
          return `# package\n\n## ${changelogVersion}\n\nCurrent release.\n`;
        }
        return JSON.stringify({
          name: packageName,
          version,
          description: "preserved",
        });
      },
      writeFileSync(path: string, contents: string): void {
        writes.push({ path, contents });
      },
      existsSync(path: string): boolean {
        const packageName = path.match(/\/packages\/([^/]+)\/CHANGELOG\.md$/)?.[1];
        return (
          packageName !== undefined && !(options.missingChangelogs ?? []).includes(packageName)
        );
      },
      log(): void {},
    },
  };
}

describe("CalVer bump CLI planning", () => {
  it("uses argv-based git and npm lookups, then applies the complete plan", () => {
    const fixture = dependencyFixture();
    const plans = main({
      rootDir: "/repo",
      now: new Date("2026-07-23T12:00:00.000Z"),
      dependencies: fixture.dependencies,
    });

    expect(fixture.commandCalls).toEqual([
      {
        command: "git",
        args: ["show", "HEAD:packages/cycling-coach/package.json"],
      },
      {
        command: "npm",
        args: [
          "view",
          "cycling-coach",
          "versions",
          "--json",
          "--registry=https://registry.npmjs.org",
        ],
      },
    ]);
    expect(plans[0].newVersion).toBe("2026.7.3");
    expect(fixture.writes).toHaveLength(2);
    expect(JSON.parse(fixture.writes[0].contents)).toMatchObject({
      version: "2026.7.3",
      description: "preserved",
    });
    expect(fixture.writes[1].contents).toContain("## 2026.7.3");
  });

  it("plans every binary before writing when a later registry lookup fails", () => {
    const fixture = dependencyFixture({
      committedVersions: { first: "2026.7.1", second: "2026.7.1" },
      registryResults: { first: '["2026.7.1"]' },
      commandErrors: { "npm:second": new Error("ETIMEDOUT") },
    });

    expect(() =>
      main({
        rootDir: "/repo",
        now: new Date("2026-07-23T12:00:00.000Z"),
        packages: ["first", "second"],
        dependencies: fixture.dependencies,
      }),
    ).toThrow(/^npm view second versions failed$/i);
    expect(fixture.writes).toEqual([]);
  });

  it("does not query npm or manufacture a release without a Changesets bump", () => {
    const fixture = dependencyFixture({
      workingVersions: { "cycling-coach": "2026.7.2" },
      committedVersions: { "cycling-coach": "2026.7.2" },
      registryResults: { "cycling-coach": "not consulted" },
    });

    expect(
      main({
        rootDir: "/repo",
        now: new Date("2026-07-23T12:00:00.000Z"),
        dependencies: fixture.dependencies,
      }),
    ).toEqual([
      expect.objectContaining({
        oldVersion: "2026.7.2",
        newVersion: "2026.7.2",
        packageChanged: false,
        changelogChanged: false,
      }),
    ]);
    expect(fixture.commandCalls).toEqual([
      {
        command: "git",
        args: ["show", "HEAD:packages/cycling-coach/package.json"],
      },
    ]);
    expect(fixture.writes).toEqual([]);
  });

  it("plans all binaries before writing when a later changelog is stale", () => {
    const fixture = dependencyFixture({
      committedVersions: { first: "2026.7.1", second: "2026.7.1" },
      registryResults: { first: '["2026.7.1"]', second: '["2026.7.1"]' },
      changelogVersions: { second: "2026.7.1" },
    });

    expect(() =>
      main({
        rootDir: "/repo",
        now: new Date("2026-07-23T12:00:00.000Z"),
        packages: ["first", "second"],
        dependencies: fixture.dependencies,
      }),
    ).toThrow(/second: CHANGELOG\.md top release header is inconsistent/i);
    expect(fixture.writes).toEqual([]);
  });

  it("fails closed without writes when a binary changelog is missing", () => {
    const fixture = dependencyFixture({
      missingChangelogs: ["cycling-coach"],
    });

    expect(() =>
      main({
        rootDir: "/repo",
        now: new Date("2026-07-23T12:00:00.000Z"),
        dependencies: fixture.dependencies,
      }),
    ).toThrow(/CHANGELOG\.md is required/i);
    expect(fixture.writes).toEqual([]);
  });

  it("returns a nonzero CLI status without exposing child-process diagnostics", () => {
    const fixture = dependencyFixture({
      commandErrors: { "npm:cycling-coach": new Error("SECRET\u001b[31m") },
    });
    const errors: string[] = [];

    expect(
      runCli(
        {
          rootDir: "/repo",
          now: new Date("2026-07-23T12:00:00.000Z"),
          dependencies: fixture.dependencies,
        },
        (message) => errors.push(message),
      ),
    ).toBe(1);
    expect(errors).toEqual(["npm view cycling-coach versions failed"]);
    expect(errors.join("")).not.toContain("SECRET");
    expect(errors.join("")).not.toContain("\u001b");
    expect(fixture.writes).toEqual([]);
  });

  it("identifies a malformed registry entry by index without echoing its value", () => {
    const secret = "SECRET\u001b[31m";
    const fixture = dependencyFixture({
      registryResults: { "cycling-coach": JSON.stringify(["2026.7.2", secret]) },
    });
    const errors: string[] = [];

    expect(
      runCli(
        {
          rootDir: "/repo",
          now: new Date("2026-07-23T12:00:00.000Z"),
          dependencies: fixture.dependencies,
        },
        (message) => errors.push(message),
      ),
    ).toBe(1);
    expect(errors).toEqual(["Malformed npm registry version at index 1"]);
    expect(errors.join("")).not.toContain("SECRET");
    expect(errors.join("")).not.toContain("\u001b");
    expect(fixture.writes).toEqual([]);
  });

  for (const scenario of [
    {
      name: "malformed registry JSON",
      options: { registryResults: { "cycling-coach": "{" } },
      expected: /registry JSON/i,
    },
    {
      name: "malformed registry version",
      options: { registryResults: { "cycling-coach": '["broken"]' } },
      expected: /registry version/i,
    },
    {
      name: "future registry maximum",
      options: { registryResults: { "cycling-coach": '["2026.8.0"]' } },
      expected: /precedes occupied version/i,
    },
    {
      name: "invalid committed version",
      options: { committedVersions: { "cycling-coach": "1.0.0" } },
      expected: /committed version is not valid CalVer/i,
    },
    {
      name: "patch overflow",
      options: {
        committedVersions: {
          "cycling-coach": `2026.7.${Number.MAX_SAFE_INTEGER}`,
        },
      },
      expected: /overflow/i,
    },
    {
      name: "failed committed lookup",
      options: { commandErrors: { "git:cycling-coach": new Error("missing HEAD") } },
      expected: /^git show for cycling-coach failed$/i,
    },
  ] as const) {
    it(`fails closed without writes for ${scenario.name}`, () => {
      const fixture = dependencyFixture(scenario.options);
      expect(() =>
        main({
          rootDir: "/repo",
          now: new Date("2026-07-23T12:00:00.000Z"),
          dependencies: fixture.dependencies,
        }),
      ).toThrow(scenario.expected);
      expect(fixture.writes).toEqual([]);
    });
  }
});
