import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";
import type { VerifyWindowsReleaseOptions } from "../scripts/verify-windows-release.mjs";
import { verifyWindowsReleaseAssets } from "../scripts/verify-windows-release.mjs";
import { windowsReleaseArtifactNames } from "../scripts/windows-release-plan.mjs";

const version = "0.1.5";
const commit = "a".repeat(40);
const releaseDate = "2026-08-25T00:00:00.000Z";
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/verify-windows-release.mjs",
);
const temporaryRoots: string[] = [];
let directory: string;
let installer: Buffer;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function metadata(overrides: Record<string, unknown> = {}) {
  const names = windowsReleaseArtifactNames(version);
  const sha512 = createHash("sha512").update(installer).digest("base64");
  return {
    version,
    files: [{ url: names.installer, sha512, size: installer.length }],
    path: names.installer,
    sha512,
    releaseDate,
    ...overrides,
  };
}

async function writeMetadata(value = metadata()) {
  await writeFile(join(directory, "latest.yml"), stringify(value));
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "windows-release-envelope-"));
  temporaryRoots.push(directory);
  installer = Buffer.from("synthetic signed Windows installer\n");
  const names = windowsReleaseArtifactNames(version);
  await Promise.all([
    writeFile(join(directory, names.installer), installer),
    writeFile(
      join(directory, names.blockmap),
      gzipSync(
        JSON.stringify({
          version: "2",
          files: [{ name: "file", offset: 0, checksums: ["x"], sizes: [1] }],
        }),
      ),
    ),
  ]);
  await writeMetadata();
});

describe("Windows release artifact verification", () => {
  it("verifies the exact envelope and records the pending Authenticode notice", async () => {
    const notice = vi.fn();
    const result = await verifyWindowsReleaseAssets(
      directory,
      { version, commit, authenticode: "pending-w19" },
      { notice },
    );
    expect(result.commit).toBe(commit);
    expect(result.authenticode).toBe("pending-w19");
    expect(result.installerSha256).toBe(createHash("sha256").update(installer).digest("hex"));
    expect(notice).toHaveBeenCalledWith(
      "Authenticode verification is pending W19; signature not verified",
    );
  });

  it("requires an explicit Authenticode mode", async () => {
    await expect(
      verifyWindowsReleaseAssets(directory, { version } as unknown as VerifyWindowsReleaseOptions),
    ).rejects.toThrow("Authenticode verification mode is required");
  });

  it("calls an injected Authenticode verifier and fails closed on rejection", async () => {
    const verify = vi.fn(async () => {});
    const result = await verifyWindowsReleaseAssets(directory, {
      version,
      expectedPublisherName: "CN=Enduragent Test",
      authenticode: { verify },
    });
    expect(verify).toHaveBeenCalledWith(join(directory, `Enduragent-${version}-x64.exe`), {
      version,
      publisherName: "CN=Enduragent Test",
    });
    expect(result.authenticode).toBe("verified");
    await expect(
      verifyWindowsReleaseAssets(directory, {
        version,
        authenticode: { verify: vi.fn(async () => Promise.reject(new Error("signature"))) },
      }),
    ).rejects.toThrow("Windows installer Authenticode verification failed");
  });

  it("rejects extra files and symlinked installers", async () => {
    await writeFile(join(directory, "extra.txt"), "extra");
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("release artifact envelope differs");
    await unlink(join(directory, "extra.txt"));
    const names = windowsReleaseArtifactNames(version);
    await unlink(join(directory, names.installer));
    await symlink(join(directory, names.blockmap), join(directory, names.installer));
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("invalid Windows installer");
  });

  it.each(["wrong sha512", "wrong size", "non-canonical releaseDate"])(
    "rejects %s metadata that does not bind the installer",
    async (failure) => {
      const value = metadata();
      if (failure === "wrong sha512") value.sha512 = "wrong";
      if (failure === "wrong size") value.files[0]!.size = 1;
      if (failure === "non-canonical releaseDate") value.releaseDate = "2026-08-25T00:00:00Z";
      await writeMetadata(value);
      await expect(
        verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
      ).rejects.toThrow("latest.yml does not match the Windows installer");
    },
  );

  it("rejects a mismatched file digest", async () => {
    const value = metadata();
    value.files[0]!.sha512 = "wrong";
    await writeMetadata(value);
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("latest.yml does not match the Windows installer");
  });

  it("rejects extra latest.yml keys as invalid", async () => {
    await writeMetadata(metadata({ unexpected: true }));
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("latest.yml is invalid");
  });

  it("rejects a non-gzip installer blockmap", async () => {
    const names = windowsReleaseArtifactNames(version);
    await writeFile(join(directory, names.blockmap), "not gzip");
    await expect(
      verifyWindowsReleaseAssets(directory, { version, authenticode: "pending-w19" }),
    ).rejects.toThrow("installer blockmap is invalid");
  });

  it("runs the pending CLI and rejects unsupported Authenticode modes", async () => {
    const { spawnSync } = await import("node:child_process");
    const success = spawnSync(
      process.execPath,
      [script, directory, "--version", version, "--authenticode", "pending-w19"],
      { encoding: "utf8" },
    );
    expect(success.status).toBe(0);
    expect(success.stdout).toMatch(/^Windows release envelope verified [0-9a-f]{64}\n$/u);
    expect(success.stderr).toBe(
      "Authenticode verification is pending W19; signature not verified\n",
    );
    const failure = spawnSync(
      process.execPath,
      [script, directory, "--version", version, "--authenticode", "verified"],
      { encoding: "utf8" },
    );
    expect(failure.status).toBe(1);
    expect(failure.stderr).toContain("Authenticode verification mode is required");
  });
});
