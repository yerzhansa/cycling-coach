import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPackage, createPackageWithOptions } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import { readBuilderAuthority, verifyPackageLayout } from "../scripts/verify-package-layout.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots: string[] = [];
const exclusions = [
  "!**/*.map",
  "!**/.env*",
  "!**/{test,tests,__tests__,fixture,fixtures,dev-fixture,dev-fixtures}/**",
  "!**/*.{test,spec}.{js,cjs,mjs,ts,cts,mts,jsx,tsx}",
  "!**/node_modules/vitest/**",
  "!**/node_modules/@vitest/**",
];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function checksum(bytes: Buffer): Buffer {
  return Buffer.from(`${createHash("sha256").update(bytes).digest("hex")}  matrix.json\n`);
}

function builderYaml(
  asarSource = "dist/self-test-asar",
  externalSource = "dist/extra-resources",
): string {
  return [
    "appId: icu.enduragent.desktop",
    "productName: Enduragent",
    "asar: true",
    "electronLanguages:",
    "  - en",
    "directories:",
    "  output: dist",
    "files:",
    "  - out/**",
    "  - package.json",
    ...exclusions.map((pattern) => `  - ${JSON.stringify(pattern)}`),
    "  - from: resources",
    "    to: resources",
    "    filter:",
    "      - trayTemplate.png",
    "      - trayTemplate@2x.png",
    `  - from: ${asarSource}`,
    "    to: .",
    "extraResources:",
    `  - from: ${externalSource}`,
    "    to: .",
    "",
  ].join("\n");
}

type SyntheticPackage = {
  app: string;
  archiveSource: string;
  desktop: string;
  externalPackaged: string;
  externalSource: string;
  resources: string;
  rebuild: () => Promise<void>;
  writeArchive: (path: string, bytes?: string | Buffer) => Promise<void>;
};

async function syntheticPackage(): Promise<SyntheticPackage> {
  const root = await mkdtemp(join(tmpdir(), "desktop-package-layout-"));
  temporaryRoots.push(root);
  const desktop = join(root, "desktop");
  const app = join(root, "Synthetic.app");
  const resources = join(app, "Contents/Resources");
  const archiveSource = join(root, "archive-source");
  const asarSource = join(desktop, "dist/self-test-asar");
  const externalSource = join(desktop, "dist/extra-resources");
  const externalPackaged = join(resources, "self-test");
  const matrix = Buffer.from('{"schemaVersion":1}\n');
  const matrixChecksum = checksum(matrix);

  await Promise.all([
    mkdir(resources, { recursive: true }),
    mkdir(join(resources, "en.lproj"), { recursive: true }),
    mkdir(archiveSource, { recursive: true }),
    mkdir(join(asarSource, "resources/self-test"), { recursive: true }),
    mkdir(join(externalSource, "self-test"), { recursive: true }),
    mkdir(desktop, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(desktop, "electron-builder.yml"), builderYaml()),
    writeFile(join(resources, "electron.icns"), "synthetic icon"),
    writeFile(join(asarSource, "resources/self-test/matrix.json"), matrix),
    writeFile(join(asarSource, "resources/self-test/matrix.sha256"), matrixChecksum),
    writeFile(join(externalSource, "self-test/matrix.json"), matrix),
    writeFile(join(externalSource, "self-test/matrix.sha256"), matrixChecksum),
    writeFile(
      join(externalSource, "self-test/self-test-runner.cjs"),
      "module.exports = { runSelfTest() { return { ok: true }; } };\n",
    ),
  ]);

  const writeArchive = async (
    path: string,
    bytes: string | Buffer = "synthetic runtime\n",
  ): Promise<void> => {
    const target = join(archiveSource, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };
  await Promise.all([
    writeArchive("out/main/index.js"),
    writeArchive("out/main/daemon-utility.js"),
    writeArchive("out/preload/index.cjs"),
    writeArchive("out/renderer/index.html", "<!doctype html>\n"),
    writeArchive("out/renderer/tray.html", "<!doctype html>\n"),
    writeArchive("package.json", '{"name":"synthetic","main":"out/main/index.js"}\n'),
    writeArchive("resources/self-test/matrix.json", matrix),
    writeArchive("resources/self-test/matrix.sha256", matrixChecksum),
  ]);

  const rebuild = async (): Promise<void> => {
    await rm(join(resources, "app.asar"), { force: true });
    await createPackage(archiveSource, join(resources, "app.asar"));
  };
  await rebuild();
  await cp(join(externalSource, "self-test"), externalPackaged, { recursive: true });
  return {
    app,
    archiveSource,
    desktop,
    externalPackaged,
    externalSource,
    resources,
    rebuild,
    writeArchive,
  };
}

describe("desktop package layout", () => {
  it("accepts the complete canonical package envelope", async () => {
    const fixture = await syntheticPackage();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).resolves.toBeUndefined();
  });

  it("uses the YAML-declared disjoint staging roots as authority", async () => {
    const fixture = await syntheticPackage();
    const alternateAsar = join(fixture.desktop, "dist/inside-authority");
    const alternateExternal = join(fixture.desktop, "dist/outside-authority");
    await Promise.all([
      rename(join(fixture.desktop, "dist/self-test-asar"), alternateAsar),
      rename(fixture.externalSource, alternateExternal),
    ]);
    await writeFile(
      join(fixture.desktop, "electron-builder.yml"),
      builderYaml("dist/inside-authority", "dist/outside-authority"),
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).resolves.toBeUndefined();
  });

  it("rejects overlapping or escaping YAML staging roots", async () => {
    const fixture = await syntheticPackage();
    await writeFile(
      join(fixture.desktop, "electron-builder.yml"),
      builderYaml("dist/self-test-asar", "dist/self-test-asar/nested"),
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("builder staging roots must be disjoint");

    await writeFile(
      join(fixture.desktop, "electron-builder.yml"),
      builderYaml("dist/self-test-asar", "../outside"),
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("builder source must be inside its output directory");
  });

  it.each(exclusions)("requires the builder exclusion %s", async (exclusion) => {
    const fixture = await syntheticPackage();
    const yaml = builderYaml().replace(`  - ${JSON.stringify(exclusion)}\n`, "");
    await writeFile(join(fixture.desktop, "electron-builder.yml"), yaml);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("builder file exclusions are incomplete");
  });

  it("validates the checked-in builder authority", async () => {
    await expect(readBuilderAuthority(desktopRoot)).resolves.toMatchObject({
      asarSourceRoot: join(desktopRoot, "dist/self-test-asar"),
      externalSourceRoot: join(desktopRoot, "dist/extra-resources"),
    });
  });

  it("pins the sole audited Electron locale", async () => {
    const fixture = await syntheticPackage();
    const yaml = builderYaml().replace("electronLanguages:\n  - en\n", "");
    await writeFile(join(fixture.desktop, "electron-builder.yml"), yaml);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("invalid builder packaging authority");

    await writeFile(
      join(fixture.desktop, "electron-builder.yml"),
      builderYaml().replace("  - en\n", "  - en\n  - fr\n"),
    );
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("invalid builder packaging authority");
  });

  it.each([
    "debug.js.map",
    ".env.production",
    "test/helper.js",
    "tests/helper.js",
    "__tests__/helper.js",
    "fixture/data.json",
    "fixtures/data.json",
    "dev-fixture/data.json",
    "dev-fixtures/data.json",
    "feature.test.js",
    "feature.spec.ts",
    "node_modules/vitest/index.js",
    "node_modules/@vitest/runner/index.js",
  ])("rejects forbidden ASAR path %s", async (path) => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive(path);
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow(/forbidden/u);
  });

  it("rejects forbidden paths in external and unpacked resources", async () => {
    const externalFixture = await syntheticPackage();
    await mkdir(join(externalFixture.externalPackaged, "fixture"), { recursive: true });
    await writeFile(join(externalFixture.externalPackaged, "fixture/private.json"), "{}\n");
    await expect(
      verifyPackageLayout(externalFixture.app, { desktopRoot: externalFixture.desktop }),
    ).rejects.toThrow("forbidden test or fixture directory");

    const unpackedFixture = await syntheticPackage();
    const unpackedTest = join(
      unpackedFixture.resources,
      "app.asar.unpacked/node_modules/@vitest/runner.js",
    );
    await mkdir(dirname(unpackedTest), { recursive: true });
    await writeFile(unpackedTest, "synthetic runtime\n");
    await expect(
      verifyPackageLayout(unpackedFixture.app, { desktopRoot: unpackedFixture.desktop }),
    ).rejects.toThrow("forbidden test or fixture directory");
  });

  it.each([
    "sentinel-anthropic-api-key",
    "sentinel-telegram-bot-token",
    "desktop-sentinel-model-key",
    "synthetic-secret",
    "obviously-fake-provider-key",
    "sk-SECRET",
    "private-token-marker",
  ])("rejects known synthetic plaintext secret marker %s", async (marker) => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive("out/main/private-marker.js", marker);
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("known plaintext secret marker");
  });

  it("scans external and unpacked files for synthetic secret markers", async () => {
    const externalFixture = await syntheticPackage();
    await writeFile(
      join(externalFixture.externalPackaged, "matrix.json"),
      "sentinel-openai-api-key",
    );
    await expect(
      verifyPackageLayout(externalFixture.app, { desktopRoot: externalFixture.desktop }),
    ).rejects.toThrow("known plaintext secret marker");

    const unpackedFixture = await syntheticPackage();
    const nativeFile = join(unpackedFixture.resources, "app.asar.unpacked/native/addon.node");
    await mkdir(dirname(nativeFile), { recursive: true });
    await writeFile(nativeFile, "sentinel-intervals-api-key");
    await expect(
      verifyPackageLayout(unpackedFixture.app, { desktopRoot: unpackedFixture.desktop }),
    ).rejects.toThrow("known plaintext secret marker");
  });

  it("allows only unpacked files declared by the ASAR header", async () => {
    const declared = await syntheticPackage();
    await declared.writeArchive("native/addon.node", "synthetic native bytes\n");
    await rm(join(declared.resources, "app.asar"));
    await createPackageWithOptions(declared.archiveSource, join(declared.resources, "app.asar"), {
      unpack: "**/*.node",
    });
    await expect(
      verifyPackageLayout(declared.app, { desktopRoot: declared.desktop }),
    ).resolves.toBeUndefined();

    const undeclared = await syntheticPackage();
    const stale = join(undeclared.resources, "app.asar.unpacked/native/addon.node");
    await mkdir(dirname(stale), { recursive: true });
    await writeFile(stale, "synthetic native bytes\n");
    await expect(
      verifyPackageLayout(undeclared.app, { desktopRoot: undeclared.desktop }),
    ).rejects.toThrow("undeclared unpacked resource");
  });

  it.each([
    "out/main/index.js",
    "out/main/daemon-utility.js",
    "out/preload/index.cjs",
    "out/renderer/index.html",
    "out/renderer/tray.html",
    "package.json",
    "resources/self-test/matrix.json",
    "resources/self-test/matrix.sha256",
  ])("rejects missing required ASAR runtime %s", async (path) => {
    const fixture = await syntheticPackage();
    await rm(join(fixture.archiveSource, path));
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("required runtime file is missing from ASAR");
  });

  it("rejects stale ASAR staging bytes", async () => {
    const fixture = await syntheticPackage();
    const changedMatrix = Buffer.from('{"schemaVersion":2}\n');
    await fixture.writeArchive("resources/self-test/matrix.json", changedMatrix);
    await fixture.writeArchive("resources/self-test/matrix.sha256", checksum(changedMatrix));
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("ASAR staging bytes differ from source");
  });

  it("rejects missing, stale, and unexpected external staging", async () => {
    const missing = await syntheticPackage();
    await rm(join(missing.externalPackaged, "matrix.sha256"));
    await expect(
      verifyPackageLayout(missing.app, { desktopRoot: missing.desktop }),
    ).rejects.toThrow("packaged external resource tree differs from staging");

    const stale = await syntheticPackage();
    await writeFile(join(stale.externalPackaged, "self-test-runner.cjs"), "module.exports = {};\n");
    await expect(verifyPackageLayout(stale.app, { desktopRoot: stale.desktop })).rejects.toThrow(
      "packaged external resource bytes differ from staging",
    );

    const unexpected = await syntheticPackage();
    await writeFile(join(unexpected.externalPackaged, "unexpected.bin"), "unexpected\n");
    await expect(
      verifyPackageLayout(unexpected.app, { desktopRoot: unexpected.desktop }),
    ).rejects.toThrow("packaged external resource tree differs from staging");
  });

  it("rejects undeclared top-level resources", async () => {
    const fixture = await syntheticPackage();
    await writeFile(join(fixture.resources, "stale-resource.json"), "{}\n");
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("undeclared package resource");
  });

  it("rejects undeclared locale directories and locale symlinks", async () => {
    const undeclared = await syntheticPackage();
    await mkdir(join(undeclared.resources, "fr.lproj"));
    await expect(
      verifyPackageLayout(undeclared.app, { desktopRoot: undeclared.desktop }),
    ).rejects.toThrow("undeclared package resource");

    const linked = await syntheticPackage();
    await rm(join(linked.resources, "en.lproj"), { recursive: true });
    await symlink(linked.resources, join(linked.resources, "en.lproj"));
    await expect(verifyPackageLayout(linked.app, { desktopRoot: linked.desktop })).rejects.toThrow(
      "symbolic links are forbidden",
    );
  });

  it("requires app.asar to be a regular nonsymlink file", async () => {
    const fixture = await syntheticPackage();
    const archive = join(fixture.resources, "app.asar");
    const target = join(dirname(fixture.app), "saved.asar");
    await rename(archive, target);
    await symlink(target, archive);
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("symbolic links are forbidden");
  });

  it("recursively rejects external and unpacked symlinks", async () => {
    const external = await syntheticPackage();
    await symlink(
      join(external.externalPackaged, "matrix.json"),
      join(external.externalPackaged, "matrix-link.json"),
    );
    await expect(
      verifyPackageLayout(external.app, { desktopRoot: external.desktop }),
    ).rejects.toThrow("symbolic links are forbidden");

    const unpacked = await syntheticPackage();
    const unpackedRoot = join(unpacked.resources, "app.asar.unpacked");
    await mkdir(unpackedRoot);
    await symlink(unpackedRoot, join(unpackedRoot, "loop"));
    await expect(
      verifyPackageLayout(unpacked.app, { desktopRoot: unpacked.desktop }),
    ).rejects.toThrow("symbolic links are forbidden");
  });

  it("keeps the external runner out of app.asar", async () => {
    const fixture = await syntheticPackage();
    await fixture.writeArchive(
      "resources/self-test/self-test-runner.cjs",
      "module.exports = {};\n",
    );
    await fixture.rebuild();
    await expect(
      verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop }),
    ).rejects.toThrow("self-test runner must remain external");
  });

  it("redacts absolute roots and secret contents from bounded errors", async () => {
    const fixture = await syntheticPackage();
    const marker = "sentinel-openrouter-api-key";
    await fixture.writeArchive("out/main/private.js", marker);
    await fixture.rebuild();
    let message = "";
    try {
      await verifyPackageLayout(fixture.app, { desktopRoot: fixture.desktop });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("app.asar/out/main/private.js");
    expect(message.length).toBeLessThanOrEqual(256);
    expect(message).not.toContain(fixture.app);
    expect(message).not.toContain(fixture.desktop);
    expect(message).not.toContain(marker);
    expect(message).not.toContain(process.env.HOME ?? "unreachable-home");
  });

  it("rejects relative application paths before filesystem access", async () => {
    await expect(verifyPackageLayout("dist/Enduragent.app")).rejects.toThrow(
      "application path must be one absolute .app path",
    );
  });
});
