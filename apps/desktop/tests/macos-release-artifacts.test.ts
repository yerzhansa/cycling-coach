import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import {
  verifyMacosApplication,
  verifyMacosReleaseArtifacts,
} from "../scripts/verify-macos-release.mjs";

const localRequire = createRequire(import.meta.url);
const builderRequire = createRequire(localRequire.resolve("electron-builder"));
const { buildBlockMap: installedBuildBlockMap } = builderRequire(
  "app-builder-lib/out/targets/blockmap/blockmap",
) as {
  buildBlockMap(inputPath: string, compression: "gzip", outputPath: string): Promise<unknown>;
};
const roots: string[] = [];
const version = "2026.7.2";
const names = {
  dmg: `Enduragent-${version}-arm64.dmg`,
  zip: `Enduragent-${version}-arm64.zip`,
  blockmap: `Enduragent-${version}-arm64.zip.blockmap`,
  metadata: "latest-mac.yml",
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-macos-release-"));
  roots.push(root);
  const repositoryRoot = join(root, "repository");
  const artifactDirectory = join(root, "artifacts");
  await Promise.all([
    mkdir(join(repositoryRoot, "packages/cycling-coach"), { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(repositoryRoot, "packages/cycling-coach/package.json"),
    `${JSON.stringify({ version })}\n`,
  );
  const zip = Buffer.from("synthetic signed ZIP bytes\n");
  const dmg = Buffer.from("synthetic signed DMG bytes\n");
  const zipSha512 = createHash("sha512").update(zip).digest("base64");
  const dmgSha512 = createHash("sha512").update(dmg).digest("base64");
  const zipPath = join(artifactDirectory, names.zip);
  const blockmapPath = join(artifactDirectory, names.blockmap);
  await Promise.all([writeFile(join(artifactDirectory, names.dmg), dmg), writeFile(zipPath, zip)]);
  await installedBuildBlockMap(zipPath, "gzip", blockmapPath);
  await writeFile(
    join(artifactDirectory, names.metadata),
    [
      `version: ${version}`,
      "files:",
      `  - url: ${names.zip}`,
      `    sha512: ${zipSha512}`,
      `    size: ${zip.length}`,
      `  - url: ${names.dmg}`,
      `    sha512: ${dmgSha512}`,
      `    size: ${dmg.length}`,
      `path: ${names.zip}`,
      `sha512: ${zipSha512}`,
      "releaseDate: '2026-07-24T00:00:00.000Z'",
      "",
    ].join("\n"),
  );
  return {
    root,
    artifactDirectory,
    repositoryRoot,
    zip,
    dmg,
    zipSha512,
    dmgSha512,
    blockmap: await readFile(blockmapPath),
  };
}

function deterministicTemporaryDirectory(root: string) {
  const directory = join(root, "enduragent-blockmap-test");
  return {
    directory,
    tmpdir: vi.fn(() => root),
    mkdtemp: vi.fn(async (prefix: string) => {
      expect(prefix).toBe(join(root, "enduragent-blockmap-"));
      await mkdir(directory);
      return directory;
    }),
  };
}

describe("macOS release artifact envelope", () => {
  it("validates both artifacts and exact regenerated blockmap bytes through the seam", async () => {
    const fixture = await releaseFixture();
    const temporary = deterministicTemporaryDirectory(fixture.root);
    const verifySignature = vi.fn(async () => {});
    const verifyNotarization = vi.fn(async () => {});
    const buildBlockMap = vi.fn(
      async (_inputPath: string, _compression: "gzip", outputPath: string) => {
        await writeFile(outputPath, fixture.blockmap);
      },
    );
    const verified = await verifyMacosReleaseArtifacts(
      fixture.artifactDirectory,
      { repositoryRoot: fixture.repositoryRoot },
      {
        buildBlockMap,
        mkdtemp: temporary.mkdtemp,
        tmpdir: temporary.tmpdir,
        verifySignature,
        verifyNotarization,
      },
    );
    expect(verified).toMatchObject({
      version,
      names,
      zipSha512: fixture.zipSha512,
      dmgSha512: fixture.dmgSha512,
      sizes: {
        zip: fixture.zip.length,
        dmg: fixture.dmg.length,
      },
    });
    expect(buildBlockMap).toHaveBeenCalledOnce();
    expect(buildBlockMap).toHaveBeenCalledWith(
      join(fixture.artifactDirectory, names.zip),
      "gzip",
      join(temporary.directory, "expected.zip.blockmap"),
    );
    await expect(lstat(temporary.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(verifySignature).toHaveBeenCalledOnce();
    expect(verifySignature).toHaveBeenCalledWith(verified);
    expect(verifyNotarization).toHaveBeenCalledOnce();
    expect(verifyNotarization).toHaveBeenCalledWith(verified);
  });

  it("accepts the pinned blockmap and invokes mandatory DMG verification defaults", async () => {
    const fixture = await releaseFixture();
    const executeFile = vi.fn(async () => {});
    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        {
          repositoryRoot: fixture.repositoryRoot,
        },
        { executeFile },
      ),
    ).resolves.toMatchObject({
      zipSha512: fixture.zipSha512,
      dmgSha512: fixture.dmgSha512,
    });
    const dmgPath = join(fixture.artifactDirectory, names.dmg);
    expect(executeFile.mock.calls).toEqual([
      ["/usr/bin/codesign", ["--verify", "--verbose=2", dmgPath]],
      ["/usr/bin/xcrun", ["stapler", "validate", "-v", dmgPath]],
      [
        "/usr/sbin/spctl",
        [
          "--assess",
          "--type",
          "open",
          "--context",
          "context:primary-signature",
          "--verbose=4",
          dmgPath,
        ],
      ],
    ]);
  });

  it("verifies the unpacked application with codesign, stapler, and Gatekeeper", async () => {
    const application = "/synthetic/Enduragent.app";
    const executeFile = vi.fn(async () => {});

    await verifyMacosApplication(application, { executeFile });

    expect(executeFile.mock.calls).toEqual([
      ["/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]],
      ["/usr/bin/xcrun", ["stapler", "validate", "-v", application]],
      ["/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", application]],
    ]);
  });

  it("fails closed without invoking later application verification commands", async () => {
    const executeFile = vi.fn(async () => {
      throw new Error("synthetic native verification failure");
    });

    await expect(
      verifyMacosApplication("/synthetic/Enduragent.app", { executeFile }),
    ).rejects.toThrow("macOS application signature verification failed");
    expect(executeFile).toHaveBeenCalledOnce();
  });

  it("fails final-envelope verification when the DMG staple is absent", async () => {
    const fixture = await releaseFixture();
    const executeFile = vi.fn(async (executable: string) => {
      if (executable === "/usr/bin/xcrun") {
        throw new Error("synthetic missing staple");
      }
    });

    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        { repositoryRoot: fixture.repositoryRoot },
        { executeFile },
      ),
    ).rejects.toThrow("macOS DMG staple verification failed");
    expect(executeFile.mock.calls).toEqual([
      [
        "/usr/bin/codesign",
        ["--verify", "--verbose=2", join(fixture.artifactDirectory, names.dmg)],
      ],
      ["/usr/bin/xcrun", ["stapler", "validate", "-v", join(fixture.artifactDirectory, names.dmg)]],
    ]);
  });

  it("rejects an envelope when mandatory DMG verification fails", async () => {
    const fixture = await releaseFixture();
    const executeFile = vi.fn(async () => {
      throw new Error("synthetic native verification failure");
    });

    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        { repositoryRoot: fixture.repositoryRoot },
        { executeFile },
      ),
    ).rejects.toThrow("macOS DMG signature verification failed");
    expect(executeFile).toHaveBeenCalledOnce();
  });

  it("cleans the exact temporary blockmap after regeneration fails", async () => {
    const fixture = await releaseFixture();
    const temporary = deterministicTemporaryDirectory(fixture.root);
    const buildBlockMap = vi.fn(
      async (_inputPath: string, _compression: "gzip", outputPath: string) => {
        await writeFile(outputPath, "partial regenerated blockmap");
        throw new Error("synthetic regeneration failure");
      },
    );
    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        { repositoryRoot: fixture.repositoryRoot },
        {
          buildBlockMap,
          mkdtemp: temporary.mkdtemp,
          tmpdir: temporary.tmpdir,
        },
      ),
    ).rejects.toThrow("unable to regenerate ZIP blockmap");
    await expect(lstat(temporary.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects missing and extra release artifacts", async () => {
    const missing = await releaseFixture();
    await rm(join(missing.artifactDirectory, names.blockmap));
    await expect(
      verifyMacosReleaseArtifacts(missing.artifactDirectory, {
        repositoryRoot: missing.repositoryRoot,
      }),
    ).rejects.toThrow("release artifact envelope differs");

    const extra = await releaseFixture();
    await writeFile(join(extra.artifactDirectory, "stale-mac.yml"), "stale\n");
    await expect(
      verifyMacosReleaseArtifacts(extra.artifactDirectory, {
        repositoryRoot: extra.repositoryRoot,
      }),
    ).rejects.toThrow("release artifact envelope differs");
  });

  it.each([
    ["version", (source: string) => source.replace(version, "2026.7.1")],
    ["ZIP filename", (source: string) => source.replace(names.zip, "stale.zip")],
    [
      "ZIP SHA-512",
      (source: string) => source.replace(/sha512: [A-Za-z0-9+/=]+/u, "sha512: stale"),
    ],
    ["ZIP size", (source: string) => source.replace(/size: \d+/u, "size: 1")],
    ["third metadata key", (source: string) => `${source}unexpected: true\n`],
  ])("rejects stale %s metadata", async (_label, mutate) => {
    const fixture = await releaseFixture();
    const path = join(fixture.artifactDirectory, names.metadata);
    await writeFile(path, mutate(await readFile(path, "utf8")));
    await expect(
      verifyMacosReleaseArtifacts(fixture.artifactDirectory, {
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).rejects.toThrow(/latest-mac\.yml/u);
  });

  it("rejects metadata whose artifact authority is not ZIP first and DMG second", async () => {
    const fixture = await releaseFixture();
    const metadataPath = join(fixture.artifactDirectory, names.metadata);
    const metadata = parse(await readFile(metadataPath, "utf8")) as {
      files: unknown[];
    };
    metadata.files.reverse();
    await writeFile(metadataPath, stringify(metadata));
    await expect(
      verifyMacosReleaseArtifacts(fixture.artifactDirectory, {
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).rejects.toThrow("latest-mac.yml does not match the release artifacts");
  });

  it("rejects stale ZIP bytes even when filenames remain unchanged", async () => {
    const fixture = await releaseFixture();
    await writeFile(join(fixture.artifactDirectory, names.zip), "different ZIP bytes\n");
    await expect(
      verifyMacosReleaseArtifacts(fixture.artifactDirectory, {
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).rejects.toThrow("latest-mac.yml does not match the release artifacts");
  });

  it("rejects tampered DMG bytes even when filenames remain unchanged", async () => {
    const fixture = await releaseFixture();
    await writeFile(join(fixture.artifactDirectory, names.dmg), "different DMG bytes\n");
    await expect(
      verifyMacosReleaseArtifacts(fixture.artifactDirectory, {
        repositoryRoot: fixture.repositoryRoot,
      }),
    ).rejects.toThrow("latest-mac.yml does not match the release artifacts");
  });

  it("rejects a blockmap that is not the exact gzip blockmap of the ZIP", async () => {
    const fixture = await releaseFixture();
    const temporary = deterministicTemporaryDirectory(fixture.root);
    await writeFile(join(fixture.artifactDirectory, names.blockmap), "tampered blockmap\n");
    await expect(
      verifyMacosReleaseArtifacts(
        fixture.artifactDirectory,
        { repositoryRoot: fixture.repositoryRoot },
        {
          mkdtemp: temporary.mkdtemp,
          tmpdir: temporary.tmpdir,
        },
      ),
    ).rejects.toThrow("ZIP blockmap does not match the ZIP artifact");
    await expect(lstat(temporary.directory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
