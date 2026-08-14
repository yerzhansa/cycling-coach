import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectCanonicalTree,
  compareInstalledTree,
  discoverInstalledPackage,
  executeWithGuaranteedUninstall,
  parseRegisteredUninstallCommands,
  runWindowsInstalledPackage,
  validateSignaturePolicy,
} from "../scripts/windows-installed-package.mjs";

const scratchRoots: string[] = [];

afterEach(async () => {
  for (const root of scratchRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

function directoryStat(extra: Record<string, unknown> = {}) {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    size: 0,
    ...extra,
  };
}

function file(path: string, sha256 = "a", size = 1) {
  return { path, type: "file" as const, size, sha256 };
}

function directory(path: string) {
  return { path, type: "directory" as const, size: 0, sha256: null };
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    keyPath: "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\x",
    keyName: "80611707-2ddf-50e5-b3ec-95f38ab4a6fa",
    displayName: "Enduragent 0.1.3",
    displayVersion: "0.1.3",
    installLocation: "C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent",
    uninstallString:
      '"C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent\\Uninstall Enduragent.exe" /currentuser',
    quietUninstallString:
      '"C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent\\Uninstall Enduragent.exe" /currentuser /S',
    ...overrides,
  };
}

describe("canonical installed package manifests", () => {
  it("streams regular files into ordinal normalized manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "w17-manifest-"));
    scratchRoots.push(root);
    await writeFile(join(root, "b.bin"), "beta");
    await writeFile(join(root, "a.bin"), "alpha");
    const manifest = await collectCanonicalTree(root, { createReadStream });
    expect(manifest.map((entry) => entry.path)).toEqual(["a.bin", "b.bin"]);
    expect(manifest.every((entry) => entry.type === "file" && entry.sha256?.length === 64)).toBe(true);
  });

  it("rejects case-fold collisions", async () => {
    await expect(
      collectCanonicalTree("/synthetic", {
        lstat: vi.fn(async () => directoryStat() as never),
        readdir: vi.fn(async (path: string) => (path === "/synthetic" ? ["A", "a"] : [])),
      }),
    ).rejects.toThrow("case-fold collision");
  });

  it("rejects reparse points", async () => {
    await expect(
      collectCanonicalTree("/synthetic", {
        lstat: vi.fn(async (path: string) =>
          directoryStat(
            path === join("/synthetic", "link") ? { isSymbolicLink: () => true } : {},
          ) as never,
        ),
        readdir: vi.fn(async (path: string) => (path === "/synthetic" ? ["link"] : [])),
      }),
    ).rejects.toThrow("reparse point");
  });

  it("accepts an exact installed tree with one exact uninstaller", () => {
    const retained = [directory("resources"), file("resources/app.asar", "one", 3)];
    const installed = [...retained, file("Uninstall Enduragent.exe", "two", 7)];
    expect(compareInstalledTree(retained, installed, "Uninstall Enduragent.exe").uninstaller).toEqual(
      file("Uninstall Enduragent.exe", "two", 7),
    );
  });

  it("compares paths case-insensitively while preserving collision rejection", () => {
    const retained = [file("Resources/App.asar", "one", 3)];
    const installed = [
      file("resources/app.asar", "one", 3),
      file("uninstall enduragent.exe", "two", 7),
    ];
    expect(compareInstalledTree(retained, installed, "Uninstall Enduragent.exe").uninstaller.path).toBe(
      "uninstall enduragent.exe",
    );
    expect(() =>
      compareInstalledTree(
        [file("A", "one"), file("a", "one")],
        [file("Uninstall Enduragent.exe", "two")],
        "Uninstall Enduragent.exe",
      ),
    ).toThrow("case-fold collision");
  });

  it.each([
    ["missing", [file("a", "one")], [file("Uninstall Enduragent.exe", "u")]],
    ["extra", [file("a", "one")], [file("a", "one"), file("extra", "x"), file("Uninstall Enduragent.exe", "u")]],
    ["hash", [file("a", "one")], [file("a", "two"), file("Uninstall Enduragent.exe", "u")]],
    ["type", [file("a", "one")], [directory("a"), file("Uninstall Enduragent.exe", "u")]],
  ])("rejects a %s tree mismatch", (_label, retained, installed) => {
    expect(() => compareInstalledTree(retained, installed, "Uninstall Enduragent.exe")).toThrow();
  });
});

describe("installed registration discovery", () => {
  const expected = {
    productName: "Enduragent",
    version: "0.1.3",
    localAppData: "C:\\Users\\runner\\AppData\\Local",
    guid: "80611707-2ddf-50e5-b3ec-95f38ab4a6fa",
  };

  it("discovers one exact registration and treats its command as inert data", () => {
    const result = discoverInstalledPackage({ registrations: [registration()] } as never, expected);
    expect(result.executable).toBe(
      "C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent\\Enduragent.exe",
    );
    expect(result.uninstaller).toBe(
      "C:\\Users\\runner\\AppData\\Local\\Programs\\Enduragent\\Uninstall Enduragent.exe",
    );
  });

  it.each([
    ["zero", []],
    ["duplicate", [registration(), registration({ keyPath: "second" })]],
    ["identity-alias", [registration(), registration({ keyName: "icu.enduragent.desktop" })]],
    ["outside", [registration({ installLocation: "C:\\Outside", uninstallString: '"C:\\Outside\\uninstall.exe"' })]],
    ["malformed", [registration({ uninstallString: "cmd.exe /c destructive" })]],
    [
      "different-quiet-path",
      [registration({ quietUninstallString: '"C:\\other\\uninstall.exe" /currentuser /S' })],
    ],
    ["version", [registration({ displayVersion: "0.1.2" })]],
    ["display-name", [registration({ displayName: "Enduragent" })]],
    ["identity", [registration({ keyName: "wrong-guid" })]],
    [
      "programs-root",
      [
        registration({
          installLocation: "c:\\users\\runner\\appdata\\local\\programs",
          uninstallString: '"c:\\users\\runner\\appdata\\local\\programs\\uninstall.exe" /currentuser',
          quietUninstallString:
            '"c:\\users\\runner\\appdata\\local\\programs\\uninstall.exe" /currentuser /S',
        }),
      ],
    ],
  ])("rejects %s registration evidence", (_label, registrations) => {
    expect(() => discoverInstalledPackage({ registrations } as never, expected)).toThrow();
  });

  it("rejects raw command syntax instead of executing it", () => {
    expect(() =>
      parseRegisteredUninstallCommands(
        {
          uninstallString: '"C:\\safe\\uninstall.exe" & calc.exe',
          quietUninstallString: '"C:\\safe\\uninstall.exe" /currentuser /S',
        },
        "C:\\safe",
      ),
    ).toThrow("malformed");
  });

  it("rejects whitespace outside the exact registered command", () => {
    expect(() =>
      parseRegisteredUninstallCommands(
        {
          uninstallString: ' "C:\\safe\\uninstall.exe" /currentuser',
          quietUninstallString: '"C:\\safe\\uninstall.exe" /currentuser /S',
        },
        "C:\\safe",
      ),
    ).toThrow("malformed");
  });

  it("accepts a direct child whose name begins with two dots", () => {
    const root = "C:\\Users\\runner\\AppData\\Local\\Programs\\..Enduragent";
    const result = discoverInstalledPackage(
      {
        registrations: [
          registration({
            installLocation: root,
            uninstallString: `"${root}\\uninstall.exe" /currentuser`,
            quietUninstallString: `"${root}\\uninstall.exe" /currentuser /S`,
          }),
        ],
      } as never,
      expected,
    );
    expect(result.installRoot).toBe(root);
  });
});

describe("unsigned private signature policy", () => {
  const installer = "C:\\artifact\\Enduragent.exe";
  const main = "C:\\installed\\Enduragent.exe";
  const uninstaller = "C:\\installed\\Uninstall Enduragent.exe";
  const owned = [installer, main, uninstaller];

  it("requires NotSigned for owned binaries and accepts native vendor status", () => {
    expect(
      validateSignaturePolicy(
        [
          ...owned.map((path) => ({ path, status: "NotSigned" })),
          { path: "C:\\installed\\ffmpeg.dll", status: "Valid" },
          { path: "C:\\installed\\vulkan-1.dll", status: "NotSigned" },
        ],
        "unsigned-private",
        owned,
        [...owned, "C:\\installed\\ffmpeg.dll", "C:\\installed\\vulkan-1.dll"],
      ),
    ).toBe(true);
  });

  it.each(["HashMismatch", "NotTrusted", "UnknownError"])("rejects vendor %s", (status) => {
    expect(() =>
      validateSignaturePolicy(
        [...owned.map((path) => ({ path, status: "NotSigned" })), { path: "C:\\installed\\vendor.dll", status }],
        "unsigned-private",
        owned,
        [...owned, "C:\\installed\\vendor.dll"],
      ),
    ).toThrow(status);
  });

  it("rejects signed owned binaries", () => {
    expect(() =>
      validateSignaturePolicy(
        owned.map((path, index) => ({ path, status: index === 0 ? "Valid" : "NotSigned" })),
        "unsigned-private",
        owned,
        owned,
      ),
    ).toThrow("Enduragent-owned");
  });

  it("rejects extra signature evidence", () => {
    expect(() =>
      validateSignaturePolicy(
        [...owned.map((path) => ({ path, status: "NotSigned" })), { path: "C:\\extra.dll", status: "Valid" }],
        "unsigned-private",
        owned,
        owned,
      ),
    ).toThrow("unexpected signature evidence");
  });
});

describe("guaranteed uninstall", () => {
  it("attempts uninstall after a primary failure", async () => {
    const uninstall = vi.fn(async () => {});
    await expect(
      executeWithGuaranteedUninstall(async () => {
        throw new Error("runtime failed");
      }, uninstall),
    ).rejects.toThrow("runtime failed");
    expect(uninstall).toHaveBeenCalledOnce();
  });

  it("preserves primary and cleanup failures", async () => {
    const failure = executeWithGuaranteedUninstall(
      async () => {
        throw new Error("runtime failed");
      },
      async () => {
        throw new Error("uninstall failed");
      },
    );
    await expect(failure).rejects.toBeInstanceOf(AggregateError);
    await expect(failure).rejects.toMatchObject({ errors: [new Error("runtime failed"), new Error("uninstall failed")] });
  });
});

describe("installed driver binding", () => {
  it("refuses execution when the immediate installer rehash differs from package evidence", async () => {
    const installerBytes = Buffer.from("changed-installer", "utf8");
    const capture = vi.fn();
    await expect(
      runWindowsInstalledPackage(
        {
          args: ["--github-hosted", "--signature-policy", "unsigned-private"],
          environment: {
            GITHUB_ACTIONS: "true",
            RUNNER_ENVIRONMENT: "github-hosted",
            USERPROFILE: "C:\\Users\\runner",
            LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
            APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
          },
          desktopRoot: "/desktop",
          platform: "win32",
          arch: "x64",
        },
        {
          createWindowsPackagePlan: vi.fn(async () => ({
            artifactPath: "/artifacts/Enduragent-0.1.3-x64.exe",
            artifactName: "Enduragent-0.1.3-x64.exe",
            applicationPath: "/retained",
            version: "0.1.3",
          })) as never,
          verifyWindowsPackage: vi.fn(async () => ({ artifact: { sha256: "different" } })) as never,
          runNativeEvidence: vi.fn(async () => ({
            ok: true,
            registrations: [],
            programResidues: [],
            processes: [],
            shortcut: {
              path: "shortcut",
              exists: false,
              targetPath: null,
              arguments: null,
              workingDirectory: null,
            },
            run: { exists: false, value: null },
            startupApproved: { exists: false, valueBase64: null },
            reparsePaths: [],
            signatures: [],
          })) as never,
          capture,
          createReadStream: vi.fn(() => Readable.from(installerBytes) as never),
          isAbsolute: () => true,
          readdir: vi.fn(async () => []),
          lstat: vi.fn(async () => directoryStat() as never),
        },
      ),
    ).rejects.toThrow("installer changed after package verification");
    expect(capture).not.toHaveBeenCalled();
  });

  it("rehashes verified evidence and attempts registered uninstall after install failure", async () => {
    const installerBytes = Buffer.from("synthetic-installer", "utf8");
    const installerSha256 = createHash("sha256").update(installerBytes).digest("hex");
    const installRoot = "C:\\Users\\runner\\AppData\\Local\\Programs\\SyntheticRoot";
    const partialRegistration = registration({
      installLocation: installRoot,
      uninstallString: `"${installRoot}\\Uninstall Enduragent.exe" /currentuser`,
      quietUninstallString: `"${installRoot}\\Uninstall Enduragent.exe" /currentuser /S`,
    });
    const emptyEvidence = {
      ok: true,
      registrations: [],
      programResidues: [],
      processes: [],
      shortcut: { path: "shortcut", exists: false, targetPath: null, arguments: null, workingDirectory: null },
      run: { exists: false, value: null },
      startupApproved: { exists: false, valueBase64: null },
      reparsePaths: [],
      signatures: [],
    };
    const runNativeEvidence = vi
      .fn()
      .mockResolvedValueOnce(emptyEvidence)
      .mockResolvedValueOnce({
        ...emptyEvidence,
        registrations: [partialRegistration],
        programResidues: [installRoot],
      })
      .mockResolvedValueOnce({ ok: true, terminated: [] })
      .mockResolvedValueOnce(emptyEvidence);
    let uninstalled = false;
    const capture = vi.fn(async (file: string) => {
      if (file === "/artifacts/Enduragent-0.1.3-x64.exe") {
        return { code: 1, signal: null, stdout: "", stderr: "install failed" };
      }
      uninstalled = true;
      return { code: 0, signal: null, stdout: "", stderr: "" };
    });
    const createReadStreamMock = vi.fn(() => Readable.from(installerBytes) as never);
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const verifyWindowsPackage = vi.fn(async () => ({
      artifact: {
        name: "Enduragent-0.1.3-x64.exe",
        size: installerBytes.length,
        sha256: installerSha256,
        peMachine: 0x8664 as const,
        nsisEnvelope: true as const,
      },
      application: { fileCount: 0, directoryCount: 0, manifestSha256: "x", peMachine: 0x8664 as const },
    }));
    await expect(
      runWindowsInstalledPackage(
        {
          args: ["--github-hosted", "--signature-policy", "unsigned-private"],
          environment: {
            GITHUB_ACTIONS: "true",
            RUNNER_ENVIRONMENT: "github-hosted",
            USERPROFILE: "C:\\Users\\runner",
            LOCALAPPDATA: "C:\\Users\\runner\\AppData\\Local",
            APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
          },
          desktopRoot: "/desktop",
          platform: "win32",
          arch: "x64",
        },
        {
          createWindowsPackagePlan: vi.fn(async () => ({
            artifactPath: "/artifacts/Enduragent-0.1.3-x64.exe",
            artifactName: "Enduragent-0.1.3-x64.exe",
            applicationPath: "/retained",
            version: "0.1.3",
          })) as never,
          verifyWindowsPackage,
          runNativeEvidence: runNativeEvidence as never,
          capture,
          createReadStream: createReadStreamMock,
          isAbsolute: () => true,
          readdir: vi.fn(async () => []),
          lstat: vi.fn(async (path: string) => {
            if (
              path === "/retained" ||
              path === "C:\\Users\\runner\\AppData\\Local\\Programs" ||
              (path === installRoot && !uninstalled)
            ) {
              return directoryStat() as never;
            }
            throw missing;
          }),
          realpath: vi.fn(async (path: string) => path),
        },
      ),
    ).rejects.toThrow("silent NSIS install failed");
    expect(verifyWindowsPackage).toHaveBeenCalledOnce();
    expect(createReadStreamMock).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenNthCalledWith(
      2,
      `${installRoot}\\Uninstall Enduragent.exe`,
      ["/currentuser", "/S"],
      120_000,
    );
  });
});
