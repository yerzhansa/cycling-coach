import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedWindowsReleaseAssets } from "../scripts/verify-windows-release.mjs";
import { runWindowsReleaseUpload } from "../scripts/upload-windows-release.mjs";
import { windowsReleaseArtifactNames } from "../scripts/windows-release-plan.mjs";

const version = "0.1.5";
const commit = "a".repeat(40);
const tag = `enduragent-desktop@${version}`;
const repository = "yerzhansa/enduragent";
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../scripts/upload-windows-release.mjs",
);
const temporaryRoots: string[] = [];
let directory: string;
let verified: VerifiedWindowsReleaseAssets;

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "windows-release-upload-"));
  temporaryRoots.push(directory);
  const names = windowsReleaseArtifactNames(version);
  const contents = {
    installer: Buffer.from("signed installer"),
    blockmap: Buffer.from("blockmap"),
    metadata: Buffer.from("metadata"),
  };
  const paths = {
    installer: join(directory, names.installer),
    blockmap: join(directory, names.blockmap),
    metadata: join(directory, names.metadata),
  };
  await Promise.all([
    writeFile(paths.installer, contents.installer),
    writeFile(paths.blockmap, contents.blockmap),
    writeFile(paths.metadata, contents.metadata),
  ]);
  verified = {
    version,
    commit,
    names,
    paths,
    sizes: {
      installer: contents.installer.length,
      blockmap: contents.blockmap.length,
      metadata: contents.metadata.length,
    },
    installerSha512: createHash("sha512").update(contents.installer).digest("base64"),
    installerSha256: createHash("sha256").update(contents.installer).digest("hex"),
    authenticode: "pending-w19",
  };
});

function release(assets: readonly string[] = [], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: "123",
    tagName: tag,
    isDraft: false,
    isPrerelease: false,
    assets: assets.map((name) => ({ name })),
    ...overrides,
  });
}

function successfulExecutor(
  options: {
    readonly initialAssets?: readonly string[];
    readonly reference?: { readonly type: "commit" | "tag"; readonly sha: string };
    readonly peeled?: { readonly type: "commit" | "tag"; readonly sha: string };
  } = {},
) {
  let views = 0;
  return vi.fn(async (_executable: string, arguments_: readonly string[]) => {
    if (arguments_[0] === "release" && arguments_[1] === "view") {
      views += 1;
      return {
        stdout:
          views === 1
            ? release(options.initialAssets ?? [`Enduragent-${version}-arm64.dmg`])
            : release(Object.values(verified.names)),
      };
    }
    if (arguments_[0] === "api" && arguments_[1]?.includes("/git/ref/tags/")) {
      return { stdout: JSON.stringify({ object: options.reference ?? { type: "commit", sha: commit } }) };
    }
    if (arguments_[0] === "api" && arguments_[1]?.includes("/git/tags/")) {
      return { stdout: JSON.stringify({ object: options.peeled ?? { type: "commit", sha: commit } }) };
    }
    return { stdout: "" };
  });
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    version,
    directory,
    commit,
    authenticode: "pending-w19" as const,
    ...overrides,
  };
}

describe("Windows release upload", () => {
  it("verifies locally, views the release, and uploads installer, blockmap, then metadata", async () => {
    const executeFile = successfulExecutor();
    const verifyAssets = vi.fn(async () => verified);
    await runWindowsReleaseUpload(input(), { executeFile, verifyAssets });
    expect(verifyAssets).toHaveBeenCalledWith(directory, {
      version,
      commit,
      authenticode: "pending-w19",
    });
    const viewArguments = [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "id,tagName,isDraft,isPrerelease,assets",
    ];
    expect(executeFile.mock.calls[0]).toEqual(["gh-personal", viewArguments]);
    expect(executeFile.mock.calls[1]).toEqual([
      "gh-personal",
      ["api", `repos/${repository}/git/ref/tags/${tag}`],
    ]);
    expect(executeFile.mock.calls[2]).toEqual([
      "gh-personal",
      [
        "release",
        "upload",
        tag,
        "--repo",
        repository,
        verified.paths.installer,
        verified.paths.blockmap,
        verified.paths.metadata,
      ],
    ]);
    expect(executeFile.mock.calls[3]).toEqual(["gh-personal", viewArguments]);
    expect(executeFile.mock.calls.flat(2)).not.toContain("--clobber");
  });

  it("binds a matching lightweight release tag to the commit", async () => {
    const result = await runWindowsReleaseUpload(input(), {
      executeFile: successfulExecutor(),
      verifyAssets: vi.fn(async () => verified),
    });
    expect(result.tagCommit).toBe(commit);
  });

  it("peels a matching annotated release tag to the commit", async () => {
    const tagObject = "b".repeat(40);
    const executeFile = successfulExecutor({
      reference: { type: "tag", sha: tagObject },
      peeled: { type: "commit", sha: commit },
    });
    const result = await runWindowsReleaseUpload(input(), {
      executeFile,
      verifyAssets: vi.fn(async () => verified),
    });
    expect(result.tagCommit).toBe(commit);
    expect(executeFile.mock.calls[2]).toEqual([
      "gh-personal",
      ["api", `repos/${repository}/git/tags/${tagObject}`],
    ]);
  });

  it("refuses a release tag commit mismatch before upload", async () => {
    const executeFile = successfulExecutor({
      reference: { type: "commit", sha: "b".repeat(40) },
    });
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow("release commit mismatch");
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("refuses an unresolvable release tag before upload", async () => {
    const executeFile = successfulExecutor({
      reference: { type: "commit", sha: "short" },
    });
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow("release tag is unresolvable");
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("refuses a missing or unparsable release", async () => {
    const executeFile = vi.fn(async () => Promise.reject(new Error("not found")));
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`release does not exist: ${tag}`);
  });

  it("refuses a draft release", async () => {
    const executeFile = vi.fn(async () => ({ stdout: release([], { isDraft: true }) }));
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`release is still a draft: ${tag}`);
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("refuses a prerelease release", async () => {
    const executeFile = vi.fn(async () => ({ stdout: release([], { isPrerelease: true }) }));
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`release is a prerelease: ${tag}`);
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("refuses pre-existing Windows assets", async () => {
    const existing = verified.names.blockmap;
    const executeFile = successfulExecutor({ initialAssets: [existing] });
    await expect(
      runWindowsReleaseUpload(input(), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`Windows release asset already exists: ${existing}`);
  });

  it("refuses a pre-existing upload record before verification or GitHub access", async () => {
    const recordPath = join(directory, "upload-record.json");
    await writeFile(recordPath, "existing");
    const executeFile = successfulExecutor();
    const verifyAssets = vi.fn(async () => verified);
    await expect(
      runWindowsReleaseUpload(input({ record: recordPath }), { executeFile, verifyAssets }),
    ).rejects.toThrow("upload record already exists");
    expect(verifyAssets).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("writes a safe failed record when release lookup fails", async () => {
    const recordPath = join(directory, "upload-record.json");
    const executeFile = vi.fn(async () => Promise.reject(new Error("not found")));
    await expect(
      runWindowsReleaseUpload(input({ record: recordPath }), {
        executeFile,
        verifyAssets: vi.fn(async () => verified),
      }),
    ).rejects.toThrow(`release does not exist: ${tag}`);
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual({
      schemaVersion: 1,
      tag,
      version,
      commit,
      arch: "x64",
      status: "failed",
      error: `release does not exist: ${tag}`,
      uploaded: false,
    });
    expect(executeFile.mock.calls.flat(2)).not.toContain("upload");
  });

  it("refuses unsupported Authenticode modes before verification or upload", async () => {
    const executeFile = vi.fn(async () => ({ stdout: "" }));
    const verifyAssets = vi.fn(async () => verified);
    await expect(
      runWindowsReleaseUpload(input({ authenticode: "verified" }) as never, {
        executeFile,
        verifyAssets,
      }),
    ).rejects.toThrow("Authenticode verification mode is required");
    expect(verifyAssets).not.toHaveBeenCalled();
    expect(executeFile).not.toHaveBeenCalled();
  });

  it("rejects an unsupported Authenticode CLI value before invoking GitHub", () => {
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--version",
        version,
        "--directory",
        directory,
        "--commit",
        commit,
        "--authenticode",
        "verified",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Authenticode verification mode is required\n");
  });

  it("writes an owner-only immutable upload record with all file hashes", async () => {
    const recordPath = join(directory, "upload-record.json");
    const result = await runWindowsReleaseUpload(input({ record: recordPath }), {
      executeFile: successfulExecutor(),
      verifyAssets: vi.fn(async () => verified),
    });
    const recorded = JSON.parse(await readFile(recordPath, "utf8"));
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
    expect(recorded).toEqual(result);
    expect(recorded).toMatchObject({
      schemaVersion: 1,
      tag,
      version,
      commit,
      tagCommit: commit,
      arch: "x64",
      status: "uploaded",
      authenticode: "pending-w19",
    });
    expect(recorded.files.map((file: { name: string }) => file.name)).toEqual([
      verified.names.installer,
      verified.names.blockmap,
      verified.names.metadata,
    ]);
    expect(
      recorded.files.every((file: { sha256: string }) => /^[0-9a-f]{64}$/u.test(file.sha256)),
    ).toBe(true);
  });
});
