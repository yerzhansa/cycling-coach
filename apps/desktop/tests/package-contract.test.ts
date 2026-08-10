import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { createPackage, createPackageWithOptions } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertExactResourceNames,
  assertNoReservedResourceNames,
  collectAsar,
  collectTree,
  compareAsarStaging,
  compareStagedTree,
  contained,
  forbiddenPathReason,
  inspectContents,
  inspectPath,
  outputChild,
  parseManifest,
  validateManifest,
  validateRelativePath,
  validateUnpackedTree,
} from "../scripts/package-inventory.mjs";
import type { AsarTreeEntry, PackageTreeEntry } from "../scripts/package-inventory.mjs";
import { createPackagePlan } from "../scripts/package-plan.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-package-contract-"));
  temporaryRoots.push(root);
  return root;
}

async function makeAsar(
  files: Readonly<Record<string, string | Buffer>>,
  unpack?: string,
): Promise<{ archive: string; source: string }> {
  const root = await temporaryRoot();
  const source = join(root, "source");
  const archive = join(root, "runtime.asar");
  await mkdir(source, { recursive: true });
  await Promise.all(
    Object.entries(files).map(async ([path, bytes]) => {
      const target = join(source, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }),
  );
  const stream =
    unpack === undefined
      ? await createPackage(source, archive)
      : await createPackageWithOptions(source, archive, { unpack });
  await finished(stream);
  return { archive, source };
}

function packageFile(bytes: string): PackageTreeEntry {
  return { type: "file", bytes: Buffer.from(bytes) };
}

function asarFile(bytes: string, unpacked = false): AsarTreeEntry {
  return {
    type: "file",
    unpacked,
    bytes: unpacked ? undefined : Buffer.from(bytes),
  };
}

function manifestAsar(bytes: Buffer): Map<string, AsarTreeEntry> {
  return new Map([["package.json", { type: "file", unpacked: false, bytes }]]);
}

describe("shared package plan", () => {
  it("constructs the frozen plan shape while preserving caller-owned configuration", async () => {
    const desktopRoot = await temporaryRoot();
    const builderConfig = { identity: "development", nested: { enabled: true } };
    const plan = createPackagePlan({
      desktopRoot,
      outputDirectory: "artifacts/development",
      applicationRelativePath: "desktop-bundle",
      executableRelativePath: "bin/launcher",
      builderConfig,
    });

    expect(plan).toEqual({
      applicationPath: join(desktopRoot, "artifacts/development/desktop-bundle"),
      executablePath: join(desktopRoot, "artifacts/development/desktop-bundle/bin/launcher"),
      outputPath: join(desktopRoot, "artifacts/development"),
      builderOptions: {
        projectDir: desktopRoot,
        publish: "never",
        config: builderConfig,
      },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.builderOptions)).toBe(false);
    expect(plan.builderOptions.config).toBe(builderConfig);
  });

  it("rejects relative and escaping plan paths at each boundary", async () => {
    const desktopRoot = await temporaryRoot();
    const valid = {
      desktopRoot,
      outputDirectory: "artifacts",
      applicationRelativePath: "bundle",
      executableRelativePath: "bin/launcher",
      builderConfig: {},
    };

    expect(() => createPackagePlan({ ...valid, desktopRoot: "relative" })).toThrow(
      "desktop root must be absolute",
    );
    expect(() =>
      createPackagePlan({ ...valid, outputDirectory: resolve(desktopRoot, "absolute-output") }),
    ).toThrow("package output directory must be relative");
    expect(() => createPackagePlan({ ...valid, outputDirectory: "." })).toThrow(
      "package output directory must be inside desktop root",
    );
    expect(() => createPackagePlan({ ...valid, outputDirectory: "../escape" })).toThrow(
      "package output directory must be inside desktop root",
    );
    expect(() =>
      createPackagePlan({
        ...valid,
        applicationRelativePath: resolve(desktopRoot, "absolute-bundle"),
      }),
    ).toThrow("application path must be relative to package output");
    expect(() => createPackagePlan({ ...valid, applicationRelativePath: "../escape" })).toThrow(
      "application path must be inside package output",
    );
    expect(() =>
      createPackagePlan({
        ...valid,
        executableRelativePath: resolve(desktopRoot, "absolute-launcher"),
      }),
    ).toThrow("executable path must be relative to application");
    expect(() => createPackagePlan({ ...valid, executableRelativePath: "../escape" })).toThrow(
      "executable path must be inside application",
    );
  });

  it("uses lexical containment for staging sources", async () => {
    const desktopRoot = await temporaryRoot();
    const outputRoot = resolve(desktopRoot, "artifacts");

    expect(contained(outputRoot, outputRoot)).toBe(true);
    expect(contained(outputRoot, resolve(outputRoot, "staging"))).toBe(true);
    expect(contained(outputRoot, resolve(desktopRoot, "artifacts-other"))).toBe(false);
    expect(outputChild(desktopRoot, outputRoot, "artifacts/staging", "authority")).toBe(
      resolve(outputRoot, "staging"),
    );
    expect(() =>
      outputChild(desktopRoot, outputRoot, resolve(outputRoot, "staging"), "authority"),
    ).toThrow("builder source must be relative: authority");
    expect(() => outputChild(desktopRoot, outputRoot, "artifacts", "authority")).toThrow(
      "builder source must be inside its output directory: authority",
    );
    expect(() => outputChild(desktopRoot, outputRoot, "artifacts-other", "authority")).toThrow(
      "builder source must be inside its output directory: authority",
    );
  });
});

describe("shared package path and content policy", () => {
  it("normalizes accepted inventory paths", () => {
    expect(validateRelativePath("/nested\\entry.js", "inventory")).toBe("nested/entry.js");
    expect(validateRelativePath("nested/entry.js", "inventory")).toBe("nested/entry.js");
  });

  it.each(["", "/", "a//b", "a/./b", "a/../b", "a\u0000b"])(
    "rejects the invalid inventory path %j",
    (path) => {
      expect(() => validateRelativePath(path, "inventory")).toThrow(
        "invalid relative package path: inventory",
      );
    },
  );

  it.each([
    ["node_modules/@anthropic-ai/claude-agent-sdk-runtime/launcher", "vendored agent CLI"],
    ["out/runtime.js.map", "source map"],
    ["out/.ENV.production", "environment file"],
    ["out/TeStS/runtime.js", "test or fixture directory"],
    ["out/runtime.spec.d.ts", "test or spec source"],
    ["out/runtime.snap", "test snapshot artifact"],
    ["out/vitest.workspace.mts", "Vitest configuration"],
  ])("classifies the forbidden path %s", (path, reason) => {
    expect(forbiddenPathReason(path)).toBe(reason);
    expect(() => inspectPath(path, "inventory-entry")).toThrow(
      `forbidden ${reason}: inventory-entry`,
    );
  });

  it.each([
    "node_modules/@modelcontextprotocol/sdk/dist/spec.types.js",
    "out/test.helpers.js",
    "out/snapshot.js",
    "out/snapshots/index.js",
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
  ])("allows the runtime path %s", (path) => {
    expect(forbiddenPathReason(path)).toBeUndefined();
    expect(() => inspectPath(path, "inventory-entry")).not.toThrow();
  });

  it("rejects secret patterns and gives acceptance-only markers precedence", () => {
    expect(() => inspectContents(Buffer.from("SENTINEL-OPENAI-API-KEY"), "payload")).toThrow(
      "known plaintext secret marker: payload",
    );
    expect(() => inspectContents(Buffer.from("obviously-fake-provider-key"), "payload")).toThrow(
      "known plaintext secret marker: payload",
    );
    expect(() => inspectContents(Buffer.from("prefix sk-SECRET suffix"), "payload")).toThrow(
      "known plaintext secret marker: payload",
    );
    expect(() =>
      inspectContents(
        Buffer.from("ENDURAGENT_ACCEPTANCE_OS_LOGIN_LAUNCH sentinel-openai-api-key"),
        "payload",
      ),
    ).toThrow("acceptance-only package marker: payload");
    expect(() => inspectContents(Buffer.from("ordinary runtime bytes"), "payload")).not.toThrow();
  });
});

describe("shared package trees", () => {
  it("collects deterministic directory and byte entries with optional scanning", async () => {
    const root = await temporaryRoot();
    await Promise.all([
      mkdir(join(root, "a"), { recursive: true }),
      mkdir(join(root, "z-empty"), { recursive: true }),
    ]);
    await writeFile(join(root, "a/private.test.js"), "synthetic-secret");

    const tree = await collectTree(root, "tree", false);
    expect([...tree.entries()]).toEqual([
      ["a", { type: "directory" }],
      ["a/private.test.js", { type: "file", bytes: Buffer.from("synthetic-secret") }],
      ["z-empty", { type: "directory" }],
    ]);
    await expect(collectTree(root, "tree", true)).rejects.toThrow(
      "forbidden test or spec source: tree/a/private.test.js",
    );
  });

  it("scans file contents and rejects symbolic links", async () => {
    const contentRoot = await temporaryRoot();
    await writeFile(join(contentRoot, "runtime.bin"), "synthetic-secret");
    await expect(collectTree(contentRoot, "content-tree", true)).rejects.toThrow(
      "known plaintext secret marker: content-tree/runtime.bin",
    );

    const linkRoot = await temporaryRoot();
    await writeFile(join(linkRoot, "target.bin"), "runtime");
    await symlink("target.bin", join(linkRoot, "link.bin"));
    await expect(collectTree(linkRoot, "link-tree", false)).rejects.toThrow(
      "symbolic links are forbidden: link-tree/link.bin",
    );
  });

  it("compares exact staged paths, types, and bytes", () => {
    const expected = new Map<string, PackageTreeEntry>([
      ["assets", { type: "directory" }],
      ["assets/runtime.bin", packageFile("expected")],
    ]);
    const exact = new Map<string, PackageTreeEntry>([
      ["assets", { type: "directory" }],
      ["assets/runtime.bin", packageFile("expected")],
    ]);
    expect(() => compareStagedTree(expected, exact, "packaged-tree")).not.toThrow();

    const unexpected = new Map(exact);
    unexpected.set("extra.bin", packageFile("extra"));
    expect(() => compareStagedTree(expected, unexpected, "packaged-tree")).toThrow(
      "packaged external resource tree differs from staging: packaged-tree",
    );

    const wrongType = new Map(exact);
    wrongType.set("assets/runtime.bin", { type: "directory" });
    expect(() => compareStagedTree(expected, wrongType, "packaged-tree")).toThrow(
      "packaged external resource type differs from staging: packaged-tree/assets/runtime.bin",
    );

    const wrongBytes = new Map(exact);
    wrongBytes.set("assets/runtime.bin", packageFile("different"));
    expect(() => compareStagedTree(expected, wrongBytes, "packaged-tree")).toThrow(
      "packaged external resource bytes differ from staging: packaged-tree/assets/runtime.bin",
    );
  });
});

describe("shared ASAR inventory", () => {
  it("collects packed entries and invalidates the ASAR cache between reads", async () => {
    const fixture = await makeAsar({ "nested/runtime.bin": "first" });
    const options = { archiveLabel: "archive", entryLabelRoot: "archive-entry" };
    const first = collectAsar(fixture.archive, options);
    expect(first.get("nested")).toEqual({ type: "directory", unpacked: false });
    expect(first.get("nested/runtime.bin")).toEqual({
      type: "file",
      unpacked: false,
      bytes: Buffer.from("first"),
    });

    await writeFile(join(fixture.source, "nested/runtime.bin"), "second");
    await rm(fixture.archive);
    const stream = await createPackage(fixture.source, fixture.archive);
    await finished(stream);
    expect(collectAsar(fixture.archive, options).get("nested/runtime.bin")).toEqual({
      type: "file",
      unpacked: false,
      bytes: Buffer.from("second"),
    });
  });

  it("rejects invalid archives and scans ASAR paths and packed contents", async () => {
    const root = await temporaryRoot();
    const invalid = join(root, "invalid.asar");
    await writeFile(invalid, "invalid archive bytes");
    expect(() =>
      collectAsar(invalid, { archiveLabel: "archive", entryLabelRoot: "archive-entry" }),
    ).toThrow("invalid ASAR archive: archive");

    const forbidden = await makeAsar({ "tests/runtime.js": "runtime" });
    expect(() =>
      collectAsar(forbidden.archive, {
        archiveLabel: "archive",
        entryLabelRoot: "archive-entry",
      }),
    ).toThrow("forbidden test or fixture directory: archive-entry/tests");

    const secret = await makeAsar({ "runtime.bin": "synthetic-secret" });
    expect(() =>
      collectAsar(secret.archive, {
        archiveLabel: "archive",
        entryLabelRoot: "archive-entry",
      }),
    ).toThrow("known plaintext secret marker: archive-entry/runtime.bin");
  });

  it("validates declared unpacked paths and entry types", async () => {
    const fixture = await makeAsar({ "native/addon.node": "native bytes" }, "**/*.node");
    const asar = collectAsar(fixture.archive, {
      archiveLabel: "archive",
      entryLabelRoot: "archive-entry",
    });
    const unpackedRoot = `${fixture.archive}.unpacked`;
    const labels = { root: "unpacked-tree", entries: "unpacked-entry" };

    expect(asar.get("native/addon.node")).toEqual({
      type: "file",
      unpacked: true,
      bytes: undefined,
    });
    await expect(validateUnpackedTree(unpackedRoot, asar, true, labels)).resolves.toBeUndefined();
    await expect(validateUnpackedTree(unpackedRoot, asar, false, labels)).rejects.toThrow(
      "declared unpacked resources are missing: unpacked-tree",
    );

    await writeFile(join(unpackedRoot, "unexpected.bin"), "unexpected");
    await expect(validateUnpackedTree(unpackedRoot, asar, true, labels)).rejects.toThrow(
      "undeclared unpacked resource: unpacked-tree",
    );
    await rm(join(unpackedRoot, "unexpected.bin"));
    await rm(join(unpackedRoot, "native/addon.node"));
    await mkdir(join(unpackedRoot, "native/addon.node"));
    await expect(validateUnpackedTree(unpackedRoot, asar, true, labels)).rejects.toThrow(
      "unpacked resource type differs from ASAR: unpacked-entry/native/addon.node",
    );
  });

  it("compares staged entries while allowing unrelated archive inventory", () => {
    const expected = new Map<string, PackageTreeEntry>([
      ["runtime", { type: "directory" }],
      ["runtime/data.bin", packageFile("expected")],
    ]);
    const exact = new Map<string, AsarTreeEntry>([
      ["runtime", { type: "directory", unpacked: false }],
      ["runtime/data.bin", asarFile("expected")],
      ["unrelated.bin", asarFile("extra")],
    ]);
    expect(() => compareAsarStaging(expected, exact)).not.toThrow();

    const missing = new Map(exact);
    missing.delete("runtime/data.bin");
    expect(() => compareAsarStaging(expected, missing)).toThrow(
      "ASAR staging entry is missing or unpacked: app.asar/runtime/data.bin",
    );

    const unpacked = new Map(exact);
    unpacked.set("runtime/data.bin", asarFile("expected", true));
    expect(() => compareAsarStaging(expected, unpacked)).toThrow(
      "ASAR staging entry is missing or unpacked: app.asar/runtime/data.bin",
    );

    const stale = new Map(exact);
    stale.set("runtime/data.bin", asarFile("different"));
    expect(() => compareAsarStaging(expected, stale)).toThrow(
      "ASAR staging bytes differ from source: app.asar/runtime/data.bin",
    );
  });
});

describe("shared manifest validation", () => {
  it("parses only object manifests with the canonical main entry", () => {
    expect(parseManifest(Buffer.from('{"main":"out/main/index.js"}'), "manifest")).toEqual({
      main: "out/main/index.js",
    });
    expect(() => parseManifest(Buffer.from("{"), "manifest")).toThrow(
      "packaged manifest is invalid: manifest",
    );
    expect(() => parseManifest(Buffer.from("[]"), "manifest")).toThrow(
      "packaged manifest has an invalid main entry: manifest",
    );
    expect(() => parseManifest(Buffer.from('{"main":"other.js"}'), "manifest")).toThrow(
      "packaged manifest has an invalid main entry: manifest",
    );
  });

  it("keeps untransformed ordinary manifests byte-exact", () => {
    const manifest = { name: "desktop-runtime", main: "out/main/index.js" };
    const source = Buffer.from(`${JSON.stringify(manifest)}\n`);
    expect(() => validateManifest(manifestAsar(source), source)).not.toThrow();

    const reformatted = Buffer.from(JSON.stringify(manifest, null, 2));
    expect(() => validateManifest(manifestAsar(reformatted), source)).toThrow(
      "ordinary packaged manifest differs from source: app.asar/package.json",
    );
  });

  it("projects removed keys and applies the conditional Babel rule", () => {
    const removedKeys = [
      "dist",
      "gitHead",
      "build",
      "jspm",
      "ava",
      "xo",
      "nyc",
      "eslintConfig",
      "contributors",
      "bundleDependencies",
      "tags",
      "scripts",
      "keywords",
      "devDependencies",
    ];
    const sourceManifest = {
      name: "desktop-runtime",
      main: "out/main/index.js",
      dependencies: { runtime: "1.0.0" },
      babel: { presets: ["runtime"] },
      _private: true,
      ...Object.fromEntries(removedKeys.map((key) => [key, { removed: true }])),
    };
    const expected = {
      name: "desktop-runtime",
      main: "out/main/index.js",
      dependencies: { runtime: "1.0.0" },
    };
    expect(() =>
      validateManifest(
        manifestAsar(Buffer.from(JSON.stringify(expected, null, 2))),
        Buffer.from(JSON.stringify(sourceManifest)),
      ),
    ).not.toThrow();

    const retainedBabelSource = {
      name: "desktop-runtime",
      main: "out/main/index.js",
      dependencies: { "babel-runtime": "1.0.0" },
      babel: { presets: ["runtime"] },
      scripts: { test: "runner" },
    };
    const retainedBabelExpected = {
      name: "desktop-runtime",
      main: "out/main/index.js",
      dependencies: { "babel-runtime": "1.0.0" },
      babel: { presets: ["runtime"] },
    };
    expect(() =>
      validateManifest(
        manifestAsar(Buffer.from(JSON.stringify(retainedBabelExpected, null, 2))),
        Buffer.from(JSON.stringify(retainedBabelSource)),
      ),
    ).not.toThrow();
  });

  it("validates exact development and release overlays", () => {
    const sourceManifest = {
      name: "desktop-runtime",
      version: "1.0.0",
      main: "out/main/index.js",
    };
    const source = Buffer.from(JSON.stringify(sourceManifest));
    const development = {
      ...sourceManifest,
      name: "desktop-runtime-development",
      enduragentDesktopDevelopment: true,
    };
    expect(() =>
      validateManifest(manifestAsar(Buffer.from(JSON.stringify(development, null, 2))), source, {
        development: true,
        developmentPackageName: "desktop-runtime-development",
      }),
    ).not.toThrow();
    expect(() =>
      validateManifest(
        manifestAsar(Buffer.from(JSON.stringify({ ...development, unexpected: true }, null, 2))),
        source,
        {
          development: true,
          developmentPackageName: "desktop-runtime-development",
        },
      ),
    ).toThrow("development packaged manifest has unexpected drift: app.asar/package.json");

    const release = {
      ...sourceManifest,
      version: "2.0.0",
      enduragentDesktopRelease: true,
    };
    expect(() =>
      validateManifest(manifestAsar(Buffer.from(JSON.stringify(release, null, 2))), source, {
        release: { version: "2.0.0" },
      }),
    ).not.toThrow();
    expect(() =>
      validateManifest(
        manifestAsar(Buffer.from(JSON.stringify({ ...release, unexpected: true }, null, 2))),
        source,
        { release: { version: "2.0.0" } },
      ),
    ).toThrow("release packaged manifest has unexpected drift: app.asar/package.json");
  });

  it.each(["enduragentDesktopRelease", "enduragentDesktopDevelopment"])(
    "rejects the source marker %s even when false",
    (marker) => {
      const manifest = {
        name: "desktop-runtime",
        main: "out/main/index.js",
        [marker]: false,
      };
      const bytes = Buffer.from(JSON.stringify(manifest));
      const expected =
        marker === "enduragentDesktopRelease"
          ? "source manifest contains a release marker: package.json"
          : "source manifest contains a development marker: package.json";
      expect(() => validateManifest(manifestAsar(bytes), bytes)).toThrow(expected);
    },
  );
});

describe("shared package resource inventory", () => {
  it("derives top-level names and rejects reserved collisions", () => {
    const tree = new Map<string, PackageTreeEntry>([
      ["assets", { type: "directory" }],
      ["assets/runtime.bin", packageFile("runtime")],
      ["data/config.json", packageFile("{}")],
    ]);
    expect(assertNoReservedResourceNames(tree, new Set(["reserved"]), "external-tree")).toEqual(
      new Set(["assets", "data"]),
    );
    expect(() => assertNoReservedResourceNames(tree, new Set(["assets"]), "external-tree")).toThrow(
      "external resources collide with reserved package entries: external-tree",
    );
  });

  it("requires the exact declared resource names", () => {
    const expected = new Set(["alpha", "beta"]);
    expect(() =>
      assertExactResourceNames(["beta", "alpha"], expected, "resource-root"),
    ).not.toThrow();
    expect(() => assertExactResourceNames(["alpha"], expected, "resource-root")).toThrow(
      "undeclared package resource: resource-root",
    );
    expect(() =>
      assertExactResourceNames(["alpha", "beta", "gamma"], expected, "resource-root"),
    ).toThrow("undeclared package resource: resource-root");
  });
});
