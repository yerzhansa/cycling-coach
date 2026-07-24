import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  DESKTOP_UPDATER_CACHE_DIRECTORY,
  createMacosReleasePlan,
  macosReleaseEnvelopePath,
  notarizeMacosDmg,
  promoteMacosReleaseEnvelope,
  requireDeveloperIdIdentity,
  requireNotarizationCredentials,
  runMacosRelease,
  sealMacosReleaseMetadata,
} from "../scripts/macos-release-plan.mjs";
import type {
  MacosReleaseBuilderOptions,
  MacosReleasePlan,
} from "../scripts/macos-release-plan.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const feedUrl = "https://updates.example.test/stable/";
const identity = "Enduragent Test (ABCDE12345)";
const notarizationEnvironment = {
  APPLE_API_KEY: "/synthetic/AuthKey.p8",
  APPLE_API_KEY_ID: "SYNTHETICKEY",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
};
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function versionReader(version = "2026.7.2") {
  return vi.fn(async () => JSON.stringify({ version }));
}

async function metadataSealFixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-metadata-seal-"));
  temporaryRoots.push(root);
  const fixtureDesktopRoot = join(root, "desktop");
  const artifactDirectory = join(fixtureDesktopRoot, "dist");
  await mkdir(artifactDirectory, { recursive: true });
  const plan = await createMacosReleasePlan(
    {
      repositoryRoot: join(root, "repository"),
      desktopRoot: fixtureDesktopRoot,
      feedUrl,
      identity,
    },
    { readFile: versionReader() },
  );
  const zip = Buffer.from("synthetic release ZIP\n");
  const dmg = Buffer.from("synthetic release DMG\n");
  const zipSha512 = createHash("sha512").update(zip).digest("base64");
  const dmgSha512 = createHash("sha512").update(dmg).digest("base64");
  const metadataPath = join(artifactDirectory, plan.artifactNames.metadata);
  await Promise.all([
    writeFile(join(artifactDirectory, plan.artifactNames.zip), zip),
    writeFile(join(artifactDirectory, plan.artifactNames.dmg), dmg),
    writeFile(join(artifactDirectory, plan.artifactNames.blockmap), "synthetic blockmap\n"),
    writeFile(
      metadataPath,
      [
        `version: ${plan.version}`,
        "files:",
        `  - url: ${plan.artifactNames.zip}`,
        `    sha512: ${zipSha512}`,
        `    size: ${zip.length}`,
        `path: ${plan.artifactNames.zip}`,
        `sha512: ${zipSha512}`,
        "releaseDate: '2026-07-24T00:00:00.000Z'",
        "",
      ].join("\n"),
    ),
  ]);
  return {
    artifactDirectory,
    dmg,
    dmgSha512,
    metadataPath,
    plan,
    zip,
    zipSha512,
  };
}

describe("macOS release plan", () => {
  it("uses only the cycling package version and creates the exact sealed overlay", async () => {
    const readVersion = versionReader();
    const plan = await createMacosReleasePlan(
      {
        repositoryRoot: "/synthetic/repository",
        desktopRoot: "/synthetic/repository/apps/desktop",
        feedUrl,
        identity,
      },
      { readFile: readVersion },
    );
    expect(readVersion).toHaveBeenCalledOnce();
    expect(readVersion).toHaveBeenCalledWith(
      "/synthetic/repository/packages/cycling-coach/package.json",
      "utf8",
    );
    expect(plan.version).toBe("2026.7.2");
    expect(plan.artifactNames).toEqual({
      dmg: "Enduragent-2026.7.2-arm64.dmg",
      zip: "Enduragent-2026.7.2-arm64.zip",
      blockmap: "Enduragent-2026.7.2-arm64.zip.blockmap",
      metadata: "latest-mac.yml",
    });
    expect(plan.builderOptions.publish).toBe("never");
    expect(plan.builderOptions.config.forceCodeSigning).toBe(true);
    expect(plan.builderOptions.config.extraMetadata).toEqual({
      version: "2026.7.2",
      enduragentDesktopRelease: true,
    });
    expect(Object.keys(plan.builderOptions.config.extraMetadata).sort()).toEqual([
      "enduragentDesktopRelease",
      "version",
    ]);
    expect(plan.builderOptions.config.publish).toEqual([
      { provider: "generic", url: feedUrl, channel: "latest" },
    ]);
    expect(plan.builderOptions.config.mac).toEqual({
      target: [
        { target: "dmg", arch: ["arm64"] },
        { target: "zip", arch: ["arm64"] },
      ],
      identity,
      hardenedRuntime: true,
      gatekeeperAssess: false,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      notarize: true,
    });
    expect(plan.builderOptions.config.dmg).toEqual({
      sign: true,
      writeUpdateInfo: false,
    });
  });

  it("accepts only a bounded unprefixed Developer ID lookup qualifier", () => {
    expect(requireDeveloperIdIdentity(identity)).toBe(identity);
    for (const prefixed of [
      `Developer ID Application: ${identity}`,
      `Developer ID Installer: ${identity}`,
      `3rd Party Mac Developer Application: ${identity}`,
      `3rd Party Mac Developer Installer: ${identity}`,
    ]) {
      expect(() => requireDeveloperIdIdentity(prefixed)).toThrow(
        "Developer ID identity qualifier is invalid",
      );
    }
    for (const invalid of [
      "",
      " ",
      ` ${identity}`,
      `${identity} `,
      `Enduragent\nTest`,
      "x".repeat(513),
    ]) {
      expect(() => requireDeveloperIdIdentity(invalid)).toThrow(
        "Developer ID identity qualifier is invalid",
      );
    }
  });

  it("matches the pinned builder identity qualifier contract without reading a keychain", async () => {
    const localRequire = createRequire(import.meta.url);
    const builderRequire = createRequire(localRequire.resolve("electron-builder"));
    const builderManifest = builderRequire("app-builder-lib/package.json") as {
      version: string;
    };
    const macCodeSign = builderRequire("app-builder-lib/out/codeSign/macCodeSign") as {
      appleCertificatePrefixes: string[];
      findIdentityRawResult: Promise<string[]> | null;
      findIdentity(type: "Developer ID Application", qualifier: string): Promise<unknown>;
    };
    expect(builderManifest.version).toBe("26.15.3");
    expect(macCodeSign.appleCertificatePrefixes).toEqual([
      "Developer ID Application:",
      "Developer ID Installer:",
      "3rd Party Mac Developer Application:",
      "3rd Party Mac Developer Installer:",
    ]);

    const originalRawResult = macCodeSign.findIdentityRawResult;
    macCodeSign.findIdentityRawResult = Promise.resolve([]);
    try {
      expect(() =>
        macCodeSign.findIdentity(
          "Developer ID Application",
          `Developer ID Application: ${identity}`,
        ),
      ).toThrow("Please remove prefix");
      const lookup = macCodeSign.findIdentity("Developer ID Application", identity);
      expect(lookup).toBeInstanceOf(Promise);
      await expect(lookup).resolves.toBeNull();
    } finally {
      macCodeSign.findIdentityRawResult = originalRawResult;
    }
  });

  it("notarizes the DMG before sealing, promoting, and verifying the exact envelope", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => [
      "/synthetic/Enduragent-2026.7.2-arm64.dmg",
    ]);
    const sealReleaseMetadata = vi.fn(async () => {});
    const verifyPackageLayout = vi.fn(async () => {});
    const executeFile = vi.fn(async () => {});
    const notarize = vi.fn(async () => {});
    const envelopePath =
      "/synthetic/repository/apps/desktop/dist/release-envelope-2026.7.2-mac-arm64";
    const temporaryEnvelopePath =
      "/synthetic/repository/apps/desktop/dist/.release-envelope-2026.7.2-mac-arm64-test";
    const promotionCommitted = vi.fn();
    const promoteReleaseEnvelope = vi.fn(
      async (
        _plan: MacosReleasePlan,
        verifyEnvelope: (artifactDirectory: string) => Promise<unknown>,
      ) => {
        await verifyEnvelope(temporaryEnvelopePath);
        promotionCommitted();
        return envelopePath;
      },
    );
    const verifyReleaseArtifacts = vi.fn(async () => {});
    const result = await runMacosRelease(
      {
        repositoryRoot: "/synthetic/repository",
        desktopRoot: "/synthetic/repository/apps/desktop",
        feedUrl,
        identity,
      },
      {
        readFile: versionReader(),
        environment: notarizationEnvironment,
        build,
        executeFile,
        notarize,
        sealReleaseMetadata,
        verifyPackageLayout,
        promoteReleaseEnvelope,
        verifyReleaseArtifacts,
      },
    );
    expect(build).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledWith(result.plan.builderOptions);
    expect(build.mock.calls[0]![0].publish).toBe("never");
    expect(sealReleaseMetadata).toHaveBeenCalledOnce();
    expect(sealReleaseMetadata).toHaveBeenCalledWith(result.plan);
    expect(verifyPackageLayout).toHaveBeenCalledOnce();
    expect(verifyPackageLayout).toHaveBeenCalledWith(
      "/synthetic/repository/apps/desktop/dist/mac-arm64/Enduragent.app",
      {
        desktopRoot: "/synthetic/repository/apps/desktop",
        release: {
          version: "2026.7.2",
          feedUrl,
        },
      },
    );
    const application = "/synthetic/repository/apps/desktop/dist/mac-arm64/Enduragent.app";
    const dmg = "/synthetic/repository/apps/desktop/dist/Enduragent-2026.7.2-arm64.dmg";
    expect(notarize).toHaveBeenCalledOnce();
    expect(notarize).toHaveBeenCalledWith({
      appPath: dmg,
      tool: "notarytool",
      appleApiKey: notarizationEnvironment.APPLE_API_KEY,
      appleApiKeyId: notarizationEnvironment.APPLE_API_KEY_ID,
      appleApiIssuer: notarizationEnvironment.APPLE_API_ISSUER,
    });
    expect(executeFile.mock.calls).toEqual([
      ["/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]],
      ["/usr/bin/xcrun", ["stapler", "validate", "-v", application]],
      ["/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", application]],
      ["/usr/bin/codesign", ["--verify", "--verbose=2", dmg]],
      ["/usr/bin/xcrun", ["stapler", "validate", "-v", dmg]],
      [
        "/usr/sbin/spctl",
        [
          "--assess",
          "--type",
          "open",
          "--context",
          "context:primary-signature",
          "--verbose=4",
          dmg,
        ],
      ],
    ]);
    expect(promoteReleaseEnvelope).toHaveBeenCalledOnce();
    expect(promoteReleaseEnvelope).toHaveBeenCalledWith(result.plan, expect.any(Function));
    expect(verifyReleaseArtifacts).toHaveBeenCalledWith(
      temporaryEnvelopePath,
      {
        repositoryRoot: "/synthetic/repository",
        readVersionFile: expect.any(Function),
      },
      { executeFile },
    );
    expect(result.envelopePath).toBe(envelopePath);
    expect(build.mock.invocationCallOrder[0]).toBeLessThan(
      verifyPackageLayout.mock.invocationCallOrder[0]!,
    );
    expect(verifyPackageLayout.mock.invocationCallOrder[0]).toBeLessThan(
      executeFile.mock.invocationCallOrder[0]!,
    );
    expect(executeFile.mock.invocationCallOrder[2]).toBeLessThan(
      notarize.mock.invocationCallOrder[0]!,
    );
    expect(notarize.mock.invocationCallOrder[0]).toBeLessThan(
      executeFile.mock.invocationCallOrder[3]!,
    );
    expect(
      executeFile.mock.invocationCallOrder[executeFile.mock.invocationCallOrder.length - 1]!,
    ).toBeLessThan(sealReleaseMetadata.mock.invocationCallOrder[0]!);
    expect(sealReleaseMetadata.mock.invocationCallOrder[0]).toBeLessThan(
      promoteReleaseEnvelope.mock.invocationCallOrder[0]!,
    );
    expect(verifyReleaseArtifacts.mock.invocationCallOrder[0]).toBeLessThan(
      promotionCommitted.mock.invocationCallOrder[0]!,
    );
  });

  it("propagates release package-layout verification failures", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const sealReleaseMetadata = vi.fn(async () => {});
    const failure = new Error("release package layout rejected");
    const verifyPackageLayout = vi.fn(async () => {
      throw failure;
    });
    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          sealReleaseMetadata,
          verifyPackageLayout,
        },
      ),
    ).rejects.toBe(failure);
    expect(build).toHaveBeenCalledOnce();
    expect(verifyPackageLayout).toHaveBeenCalledOnce();
    expect(sealReleaseMetadata).not.toHaveBeenCalled();
  });

  it("fails closed after notarization and native verification when metadata sealing fails", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const failure = new Error("release metadata rejected");
    const sealReleaseMetadata = vi.fn(async () => {
      throw failure;
    });
    const verifyPackageLayout = vi.fn(async () => {});
    const executeFile = vi.fn(async () => {});
    const notarize = vi.fn(async () => {});
    const promoteReleaseEnvelope = vi.fn(async () => "/synthetic/envelope");
    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          executeFile,
          notarize,
          sealReleaseMetadata,
          verifyPackageLayout,
          promoteReleaseEnvelope,
        },
      ),
    ).rejects.toBe(failure);
    expect(build).toHaveBeenCalledOnce();
    expect(verifyPackageLayout).toHaveBeenCalledOnce();
    expect(notarize).toHaveBeenCalledOnce();
    expect(executeFile).toHaveBeenCalledTimes(6);
    expect(sealReleaseMetadata).toHaveBeenCalledOnce();
    expect(promoteReleaseEnvelope).not.toHaveBeenCalled();
  });

  it("requires exactly one complete notarization credential set", () => {
    expect(
      requireNotarizationCredentials({
        APPLE_ID: "release@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: "synthetic-password",
        APPLE_TEAM_ID: "ABCDE12345",
      }),
    ).toEqual({
      name: "apple-id",
      options: {
        appleId: "release@example.test",
        appleIdPassword: "synthetic-password",
        teamId: "ABCDE12345",
      },
    });
    expect(requireNotarizationCredentials(notarizationEnvironment)).toEqual({
      name: "api-key",
      options: {
        appleApiKey: "/synthetic/AuthKey.p8",
        appleApiKeyId: "SYNTHETICKEY",
        appleApiIssuer: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(
      requireNotarizationCredentials({
        APPLE_KEYCHAIN: "/synthetic/login.keychain-db",
        APPLE_KEYCHAIN_PROFILE: "enduragent-notary",
      }),
    ).toEqual({
      name: "keychain-profile",
      options: {
        keychain: "/synthetic/login.keychain-db",
        keychainProfile: "enduragent-notary",
      },
    });
    expect(
      requireNotarizationCredentials({
        APPLE_KEYCHAIN_PROFILE: "enduragent-default-keychain-notary",
      }),
    ).toEqual({
      name: "keychain-profile",
      options: {
        keychainProfile: "enduragent-default-keychain-notary",
      },
    });

    expect(() => requireNotarizationCredentials({})).toThrow(
      "notarization credentials are missing",
    );
    expect(() =>
      requireNotarizationCredentials({
        APPLE_ID: "release@example.test",
        APPLE_TEAM_ID: "ABCDE12345",
      }),
    ).toThrow("notarization credentials are incomplete");
    expect(() =>
      requireNotarizationCredentials({
        ...notarizationEnvironment,
        APPLE_ID: "release@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: "synthetic-password",
        APPLE_TEAM_ID: "ABCDE12345",
      }),
    ).toThrow("notarization credential configuration is ambiguous");
  });

  it.each([
    {
      environment: {
        APPLE_ID: "release@example.test",
        APPLE_APP_SPECIFIC_PASSWORD: "synthetic-password",
        APPLE_TEAM_ID: "ABCDE12345",
      },
      options: {
        appleId: "release@example.test",
        appleIdPassword: "synthetic-password",
        teamId: "ABCDE12345",
      },
    },
    {
      environment: notarizationEnvironment,
      options: {
        appleApiKey: "/synthetic/AuthKey.p8",
        appleApiKeyId: "SYNTHETICKEY",
        appleApiIssuer: "00000000-0000-0000-0000-000000000000",
      },
    },
    {
      environment: {
        APPLE_KEYCHAIN_PROFILE: "enduragent-notary",
      },
      options: {
        keychainProfile: "enduragent-notary",
      },
    },
    {
      environment: {
        APPLE_KEYCHAIN: "/synthetic/login.keychain-db",
        APPLE_KEYCHAIN_PROFILE: "enduragent-notary",
      },
      options: {
        keychain: "/synthetic/login.keychain-db",
        keychainProfile: "enduragent-notary",
      },
    },
  ])("maps the selected credential strategy exactly into the pinned API", async (fixture) => {
    const notarize = vi.fn(async () => {});
    const credentials = requireNotarizationCredentials(fixture.environment);

    await notarizeMacosDmg("/synthetic/Enduragent.dmg", credentials, { notarize });

    expect(notarize).toHaveBeenCalledOnce();
    expect(notarize).toHaveBeenCalledWith({
      appPath: "/synthetic/Enduragent.dmg",
      tool: "notarytool",
      ...fixture.options,
    });
  });

  it("keeps DMG path and notarytool authoritative over credential option fields", async () => {
    const notarize = vi.fn(async () => {});
    const credentials = {
      name: "keychain-profile",
      options: {
        keychainProfile: "enduragent-notary",
        appPath: "/synthetic/untrusted.dmg",
        tool: "legacy",
      },
    } as never;

    await notarizeMacosDmg("/synthetic/authoritative.dmg", credentials, {
      notarize,
    });

    expect(notarize).toHaveBeenCalledWith({
      keychainProfile: "enduragent-notary",
      appPath: "/synthetic/authoritative.dmg",
      tool: "notarytool",
    });
  });

  it("fails credential preflight before loading or invoking electron-builder", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const sealReleaseMetadata = vi.fn(async () => {});

    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
        },
        {
          readFile: versionReader(),
          environment: {},
          build,
          sealReleaseMetadata,
        },
      ),
    ).rejects.toThrow("notarization credentials are missing");
    expect(build).not.toHaveBeenCalled();
    expect(sealReleaseMetadata).not.toHaveBeenCalled();
  });

  it("stops before envelope promotion when mandatory native verification fails", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const sealReleaseMetadata = vi.fn(async () => {});
    const verifyPackageLayout = vi.fn(async () => {});
    const executeFile = vi.fn(async () => {
      throw new Error("synthetic codesign failure");
    });
    const promoteReleaseEnvelope = vi.fn(async () => "/synthetic/envelope");
    const verifyReleaseArtifacts = vi.fn(async () => {});

    await expect(
      runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          sealReleaseMetadata,
          verifyPackageLayout,
          executeFile,
          promoteReleaseEnvelope,
          verifyReleaseArtifacts,
        },
      ),
    ).rejects.toThrow("macOS application signature verification failed");
    expect(executeFile).toHaveBeenCalledOnce();
    expect(promoteReleaseEnvelope).not.toHaveBeenCalled();
    expect(verifyReleaseArtifacts).not.toHaveBeenCalled();
  });

  it("redacts notarize or staple failures and stops before sealing or promotion", async () => {
    const build = vi.fn(async (_options: MacosReleaseBuilderOptions) => []);
    const sealReleaseMetadata = vi.fn(async () => {});
    const verifyPackageLayout = vi.fn(async () => {});
    const executeFile = vi.fn(async () => {});
    const notarize = vi.fn(async () => {
      throw new Error(`submission failed for ${notarizationEnvironment.APPLE_API_KEY_ID}`);
    });
    const promoteReleaseEnvelope = vi.fn(async () => "/synthetic/envelope");

    let failure: unknown;
    try {
      await runMacosRelease(
        {
          repositoryRoot: "/synthetic/repository",
          desktopRoot: "/synthetic/repository/apps/desktop",
          feedUrl,
          identity,
        },
        {
          readFile: versionReader(),
          environment: notarizationEnvironment,
          build,
          verifyPackageLayout,
          executeFile,
          notarize,
          sealReleaseMetadata,
          promoteReleaseEnvelope,
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toBe("macOS DMG notarization failed");
    expect((failure as Error).message).not.toContain(notarizationEnvironment.APPLE_API_KEY_ID);
    expect(executeFile).toHaveBeenCalledTimes(3);
    expect(sealReleaseMetadata).not.toHaveBeenCalled();
    expect(promoteReleaseEnvelope).not.toHaveBeenCalled();
  });

  it("atomically seals zip-only builder metadata with ZIP-first and DMG-second authority", async () => {
    const fixture = await metadataSealFixture();
    const expectedEnvelope = Object.values(fixture.plan.artifactNames).sort();
    expect((await readdir(fixture.artifactDirectory)).sort()).toEqual(expectedEnvelope);

    await sealMacosReleaseMetadata(fixture.plan);

    expect((await readdir(fixture.artifactDirectory)).sort()).toEqual(expectedEnvelope);
    expect(parse(await readFile(fixture.metadataPath, "utf8"))).toEqual({
      version: fixture.plan.version,
      files: [
        {
          url: fixture.plan.artifactNames.zip,
          sha512: fixture.zipSha512,
          size: fixture.zip.length,
        },
        {
          url: fixture.plan.artifactNames.dmg,
          sha512: fixture.dmgSha512,
          size: fixture.dmg.length,
        },
      ],
      path: fixture.plan.artifactNames.zip,
      sha512: fixture.zipSha512,
      releaseDate: "2026-07-24T00:00:00.000Z",
    });
  });

  it("hashes the final stapled DMG bytes only after outer notarization completes", async () => {
    const fixture = await metadataSealFixture();
    const stapledDmg = Buffer.concat([fixture.dmg, Buffer.from("synthetic stapled ticket\n")]);
    const notarize = vi.fn(async (options: { appPath: string }) => {
      await writeFile(options.appPath, stapledDmg);
    });
    const verifyApplication = vi.fn(async () => {});
    const verifyDmg = vi.fn(async (path: string) => {
      expect(await readFile(path)).toEqual(stapledDmg);
    });
    const envelopePath = join(fixture.artifactDirectory, "synthetic-envelope");

    await runMacosRelease(
      {
        repositoryRoot: join(fixture.artifactDirectory, "repository"),
        desktopRoot: fixture.plan.builderOptions.projectDir,
        feedUrl,
        identity,
      },
      {
        readFile: versionReader(),
        environment: notarizationEnvironment,
        build: vi.fn(async () => []),
        verifyPackageLayout: vi.fn(async () => {}),
        verifyApplication,
        notarize,
        verifyDmg,
        promoteReleaseEnvelope: vi.fn(
          async (
            _plan: MacosReleasePlan,
            verifyEnvelope: (artifactDirectory: string) => Promise<unknown>,
          ) => {
            await verifyEnvelope(envelopePath);
            return envelopePath;
          },
        ),
        verifyReleaseArtifacts: vi.fn(async () => {}),
      },
    );

    const metadata = parse(await readFile(fixture.metadataPath, "utf8")) as {
      files: Array<{ url: string; sha512: string; size: number }>;
    };
    expect(notarize).toHaveBeenCalledOnce();
    expect(verifyDmg).toHaveBeenCalledOnce();
    expect(notarize.mock.invocationCallOrder[0]).toBeLessThan(
      verifyDmg.mock.invocationCallOrder[0]!,
    );
    expect(metadata.files[1]).toEqual({
      url: fixture.plan.artifactNames.dmg,
      sha512: createHash("sha512").update(stapledDmg).digest("base64"),
      size: stapledDmg.length,
    });
    expect(metadata.files[1]?.sha512).not.toBe(fixture.dmgSha512);
  });

  it("leaves builder metadata untouched when zip-only authority validation fails", async () => {
    const fixture = await metadataSealFixture();
    const original = await readFile(fixture.metadataPath);
    await writeFile(
      fixture.metadataPath,
      original.toString("utf8").replace(fixture.zipSha512, "stale"),
    );
    const invalid = await readFile(fixture.metadataPath);

    await expect(sealMacosReleaseMetadata(fixture.plan)).rejects.toThrow(
      "builder latest-mac.yml does not match the ZIP artifact",
    );
    expect(await readFile(fixture.metadataPath)).toEqual(invalid);
    expect((await readdir(fixture.artifactDirectory)).sort()).toEqual(
      Object.values(fixture.plan.artifactNames).sort(),
    );
  });

  it("atomically promotes only the four release artifacts while preserving builder output", async () => {
    const fixture = await metadataSealFixture();
    const builderApplication = join(fixture.artifactDirectory, "mac-arm64/Enduragent.app");
    const builderScratch = join(fixture.artifactDirectory, "builder-scratch");
    await Promise.all([
      mkdir(builderApplication, { recursive: true }),
      mkdir(builderScratch, { recursive: true }),
    ]);
    await sealMacosReleaseMetadata(fixture.plan);
    const sourceBytes = new Map(
      await Promise.all(
        Object.values(fixture.plan.artifactNames).map(
          async (name) => [name, await readFile(join(fixture.artifactDirectory, name))] as const,
        ),
      ),
    );

    const verifyEnvelope = vi.fn(async (temporaryPath: string) => {
      expect(temporaryPath).not.toBe(macosReleaseEnvelopePath(fixture.plan));
      await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect((await readdir(temporaryPath)).sort()).toEqual(
        Object.values(fixture.plan.artifactNames).sort(),
      );
    });

    const envelopePath = await promoteMacosReleaseEnvelope(fixture.plan, verifyEnvelope);

    expect(envelopePath).toBe(macosReleaseEnvelopePath(fixture.plan));
    expect(verifyEnvelope).toHaveBeenCalledOnce();
    expect((await readdir(envelopePath)).sort()).toEqual(
      Object.values(fixture.plan.artifactNames).sort(),
    );
    for (const [name, bytes] of sourceBytes) {
      expect(await readFile(join(envelopePath, name))).toEqual(bytes);
      expect(await readFile(join(fixture.artifactDirectory, name))).toEqual(bytes);
    }
    expect((await lstat(builderApplication)).isDirectory()).toBe(true);
    expect((await lstat(builderScratch)).isDirectory()).toBe(true);
  });

  it("never overwrites a stale release envelope", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const envelopePath = macosReleaseEnvelopePath(fixture.plan);
    const sentinelPath = join(envelopePath, "sentinel");
    await mkdir(envelopePath);
    await writeFile(sentinelPath, "keep me\n");

    const verifyEnvelope = vi.fn(async () => {});
    await expect(promoteMacosReleaseEnvelope(fixture.plan, verifyEnvelope)).rejects.toThrow(
      "release envelope destination already exists",
    );
    expect(verifyEnvelope).not.toHaveBeenCalled();
    expect(await readFile(sentinelPath, "utf8")).toBe("keep me\n");
    expect(
      (await readdir(fixture.artifactDirectory)).filter((name) =>
        name.startsWith(`.release-envelope-${fixture.plan.version}-mac-arm64-`),
      ),
    ).toEqual([]);
  });

  it("cleans a semantically rejected temp envelope and permits a clean rerun", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const sourceBytes = new Map(
      await Promise.all(
        Object.values(fixture.plan.artifactNames).map(
          async (name) => [name, await readFile(join(fixture.artifactDirectory, name))] as const,
        ),
      ),
    );
    const envelopePath = macosReleaseEnvelopePath(fixture.plan);
    const failure = new Error("semantic envelope rejection");
    const rejectEnvelope = vi.fn(async (temporaryPath: string) => {
      expect((await readdir(temporaryPath)).sort()).toEqual(
        Object.values(fixture.plan.artifactNames).sort(),
      );
      await expect(lstat(envelopePath)).rejects.toMatchObject({ code: "ENOENT" });
      throw failure;
    });

    await expect(promoteMacosReleaseEnvelope(fixture.plan, rejectEnvelope)).rejects.toBe(failure);

    await expect(lstat(envelopePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await readdir(fixture.artifactDirectory)).filter((name) =>
        name.startsWith(`.release-envelope-${fixture.plan.version}-mac-arm64-`),
      ),
    ).toEqual([]);
    for (const [name, bytes] of sourceBytes) {
      expect(await readFile(join(fixture.artifactDirectory, name))).toEqual(bytes);
    }

    const acceptEnvelope = vi.fn(async () => {});
    await expect(promoteMacosReleaseEnvelope(fixture.plan, acceptEnvelope)).resolves.toBe(
      envelopePath,
    );
    expect(acceptEnvelope).toHaveBeenCalledOnce();
  });

  it("rejects a temp artifact changed by semantic verification before rename", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const mutateEnvelope = vi.fn(async (temporaryPath: string) => {
      await writeFile(
        join(temporaryPath, fixture.plan.artifactNames.zip),
        "mutated during semantic verification\n",
      );
    });

    await expect(promoteMacosReleaseEnvelope(fixture.plan, mutateEnvelope)).rejects.toThrow(
      "release envelope changed during verification",
    );
    await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(fixture.artifactDirectory)).filter((name) =>
        name.startsWith(`.release-envelope-${fixture.plan.version}-mac-arm64-`),
      ),
    ).toEqual([]);
  });

  it("rechecks builder source identity after semantic verification", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const mutateSource = vi.fn(async () => {
      await writeFile(
        join(fixture.artifactDirectory, fixture.plan.artifactNames.zip),
        "builder source changed during verification\n",
      );
    });

    await expect(promoteMacosReleaseEnvelope(fixture.plan, mutateSource)).rejects.toThrow(
      "release artifact changed during promotion",
    );
    await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("requires semantic verification before release-envelope promotion", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);

    await expect(promoteMacosReleaseEnvelope(fixture.plan, undefined as never)).rejects.toThrow(
      "release envelope verifier is required",
    );
    await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects symlinked source artifacts without leaving a partial envelope", async () => {
    const fixture = await metadataSealFixture();
    await sealMacosReleaseMetadata(fixture.plan);
    const blockmapPath = join(fixture.artifactDirectory, fixture.plan.artifactNames.blockmap);
    await rm(blockmapPath);
    await symlink(fixture.plan.artifactNames.zip, blockmapPath);

    const verifyEnvelope = vi.fn(async () => {});
    await expect(promoteMacosReleaseEnvelope(fixture.plan, verifyEnvelope)).rejects.toThrow(
      "invalid ZIP blockmap",
    );
    expect(verifyEnvelope).not.toHaveBeenCalled();
    await expect(lstat(macosReleaseEnvelopePath(fixture.plan))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await readdir(fixture.artifactDirectory)).filter((name) =>
        name.startsWith(`.release-envelope-${fixture.plan.version}-mac-arm64-`),
      ),
    ).toEqual([]);
  });

  it.each(["2026.07.2", "2026.7.02", "2026.13.0", "2026.0.1", "2026.7.2-1", "0.0.1", "", "latest"])(
    "rejects a non-stable release version: %s",
    async (version) => {
      await expect(
        createMacosReleasePlan(
          {
            repositoryRoot: "/synthetic/repository",
            feedUrl,
            identity,
          },
          { readFile: versionReader(version) },
        ),
      ).rejects.toThrow("stable CalVer");
    },
  );

  it.each([
    "http://updates.example.test/stable/",
    "https://user:secret@updates.example.test/stable/",
    "https://updates.example.test/stable",
    "https://updates.example.test/stable/?token=value",
    "https://updates.example.test/stable/#fragment",
    "/stable/",
    "",
  ])("rejects a noncanonical release feed URL: %s", async (invalidFeedUrl) => {
    await expect(
      createMacosReleasePlan(
        {
          repositoryRoot: "/synthetic/repository",
          feedUrl: invalidFeedUrl,
          identity,
        },
        { readFile: versionReader() },
      ),
    ).rejects.toThrow("feed URL");
  });

  it("checks in only the minimum Electron hardened-runtime entitlement", async () => {
    const entitlements = await readFile(join(desktopRoot, "build/entitlements.mac.plist"), "utf8");
    expect(Array.from(entitlements.matchAll(/<key>([^<]+)<\/key>/gu), (match) => match[1])).toEqual(
      ["com.apple.security.cs.allow-jit"],
    );
    expect(entitlements.match(/<true\/>/gu)).toHaveLength(1);
    expect(entitlements).not.toMatch(
      /allow-unsigned-executable-memory|disable-library-validation|network\.server/iu,
    );
  });

  it("matches electron-builder's updater cache name for the scoped desktop package", () => {
    const localRequire = createRequire(import.meta.url);
    const builderRequire = createRequire(localRequire.resolve("electron-builder"));
    const { sanitizeFileName } = builderRequire("builder-util/out/filename") as {
      sanitizeFileName(value: string): string;
    };
    expect(DESKTOP_UPDATER_CACHE_DIRECTORY).toBe(
      `${sanitizeFileName("@enduragent/desktop").toLowerCase()}-updater`,
    );
  });

  it("declares and resolves the exact pinned outer notarization dependency", async () => {
    const manifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
      devDependencies: Record<string, string>;
    };
    const localRequire = createRequire(import.meta.url);
    const dependencyManifest = JSON.parse(
      await readFile(localRequire.resolve("@electron/notarize/package.json"), "utf8"),
    ) as { version: string };

    expect(manifest.devDependencies["@electron/notarize"]).toBe("2.5.0");
    expect(dependencyManifest.version).toBe("2.5.0");
  });

  it("reads the live version authority without consulting the desktop manifest", async () => {
    const plan = await createMacosReleasePlan({
      repositoryRoot,
      desktopRoot,
      feedUrl,
      identity,
    });
    const manifest = JSON.parse(
      await readFile(join(repositoryRoot, "packages/cycling-coach/package.json"), "utf8"),
    ) as { version: string };
    expect(plan.version).toBe(manifest.version);
    expect(plan.version).not.toBe("0.0.1");
  });
});
