import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  WINDOWS_AUTHENTICODE_PENDING,
  requireReleaseCommit,
  windowsReleaseArtifactNames,
} from "./windows-release-plan.mjs";
import {
  safeWindowsReleaseVerificationMessage,
  verifyWindowsReleaseAssets,
} from "./verify-windows-release.mjs";
import { requireStableSemVer } from "./macos-release-plan.mjs";

const execFileAsync = promisify(execFile);
const defaultRepository = "yerzhansa/enduragent";
const safeWindowsReleaseUploadMessages = new Set([
  "release tag mismatch",
  "release tag is unresolvable",
  "release commit mismatch",
  "Windows release upload is incomplete",
  "Authenticode verification mode is required",
  "upload record path must be absolute",
  "upload record already exists",
  "upload record directory is missing",
  "release repository is invalid",
]);
const safeReleaseStateMessagePattern =
  /^(?:release does not exist|release is still a draft|release is a prerelease): enduragent-desktop@[-A-Za-z0-9@._]+$/u;
const safeExistingAssetMessagePattern = /^Windows release asset already exists: [-A-Za-z0-9@._]+$/u;

async function executeSystemFile(executable, arguments_) {
  const result = await execFileAsync(executable, [...arguments_], { encoding: "utf8" });
  return { stdout: result.stdout };
}

export function safeWindowsReleaseUploadMessage(error) {
  return error instanceof TypeError &&
    (safeWindowsReleaseUploadMessages.has(error.message) ||
      safeReleaseStateMessagePattern.test(error.message) ||
      safeExistingAssetMessagePattern.test(error.message))
    ? error.message
    : undefined;
}

function requireRepository(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value)) {
    throw new TypeError("release repository is invalid");
  }
  return value;
}

function parseRelease(stdout, tag) {
  let release;
  try {
    release = JSON.parse(stdout);
  } catch {
    throw new TypeError(`release does not exist: ${tag}`);
  }
  if (
    release === null ||
    typeof release !== "object" ||
    Array.isArray(release) ||
    typeof release.tagName !== "string" ||
    typeof release.isDraft !== "boolean" ||
    typeof release.isPrerelease !== "boolean" ||
    !Array.isArray(release.assets)
  ) {
    throw new TypeError(`release does not exist: ${tag}`);
  }
  if (release.isDraft) throw new TypeError(`release is still a draft: ${tag}`);
  if (release.isPrerelease) throw new TypeError(`release is a prerelease: ${tag}`);
  if (release.tagName !== tag) throw new TypeError("release tag mismatch");
  return release;
}

async function viewRelease(executeFile, tag, repository) {
  let result;
  try {
    result = await executeFile("gh-personal", [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "id,tagName,isDraft,isPrerelease,assets",
    ]);
  } catch {
    throw new TypeError(`release does not exist: ${tag}`);
  }
  return parseRelease(result.stdout, tag);
}

function releaseAssetNames(release) {
  return release.assets.flatMap((asset) =>
    asset !== null && typeof asset === "object" && typeof asset.name === "string"
      ? [asset.name]
      : [],
  );
}

function parseGitObject(stdout) {
  let response;
  try {
    response = JSON.parse(stdout);
  } catch {
    throw new TypeError("release tag is unresolvable");
  }
  const object = response?.object;
  if (
    object === null ||
    typeof object !== "object" ||
    Array.isArray(object) ||
    (object.type !== "commit" && object.type !== "tag") ||
    typeof object.sha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(object.sha)
  ) {
    throw new TypeError("release tag is unresolvable");
  }
  return object;
}

async function resolveTagCommit(executeFile, repository, tag) {
  let reference;
  try {
    const result = await executeFile("gh-personal", [
      "api",
      `repos/${repository}/git/ref/tags/${tag}`,
    ]);
    reference = parseGitObject(result.stdout);
  } catch {
    throw new TypeError("release tag is unresolvable");
  }
  if (reference.type === "commit") return reference.sha;
  let peeled;
  try {
    const result = await executeFile("gh-personal", [
      "api",
      `repos/${repository}/git/tags/${reference.sha}`,
    ]);
    peeled = parseGitObject(result.stdout);
  } catch {
    throw new TypeError("release tag is unresolvable");
  }
  if (peeled.type !== "commit") throw new TypeError("release tag is unresolvable");
  return peeled.sha;
}

async function releaseFileRecords(verified, dependencies) {
  const entries = [
    [verified.names.installer, verified.paths.installer, verified.sizes.installer],
    [verified.names.blockmap, verified.paths.blockmap, verified.sizes.blockmap],
    [verified.names.metadata, verified.paths.metadata, verified.sizes.metadata],
  ];
  return Promise.all(
    entries.map(async ([name, path, size]) => {
      const bytes = await dependencies.readFile(path);
      if (bytes.length !== size) throw new TypeError("Windows release upload is incomplete");
      return Object.freeze({
        name,
        size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }),
  );
}

export async function runWindowsReleaseUpload(input, dependencies = {}) {
  const version = requireStableSemVer(input.version);
  const commit = requireReleaseCommit(input.commit);
  if (!isAbsolute(input.directory)) throw new TypeError("artifact directory must be absolute");
  if (input.authenticode !== WINDOWS_AUTHENTICODE_PENDING) {
    throw new TypeError("Authenticode verification mode is required");
  }
  const repository = requireRepository(input.repo ?? defaultRepository);
  if (input.record !== undefined && !isAbsolute(input.record)) {
    throw new TypeError("upload record path must be absolute");
  }
  const executeFile = dependencies.executeFile ?? executeSystemFile;
  const verifyAssets = dependencies.verifyAssets ?? verifyWindowsReleaseAssets;
  const fileDependencies = {
    readFile: dependencies.readFile ?? readFile,
    writeFile: dependencies.writeFile ?? writeFile,
  };
  const tag = `enduragent-desktop@${version}`;
  const expectedNames = Object.values(windowsReleaseArtifactNames(version));
  if (input.record !== undefined) {
    try {
      await fileDependencies.writeFile(input.record, "", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error?.code === "EEXIST") throw new TypeError("upload record already exists");
      if (error?.code === "ENOENT") throw new TypeError("upload record directory is missing");
      throw error;
    }
  }
  let uploaded = false;
  try {
    const verified = await verifyAssets(input.directory, {
      version,
      commit,
      authenticode: input.authenticode,
    });
    const files = Object.freeze(await releaseFileRecords(verified, fileDependencies));
    const release = await viewRelease(executeFile, tag, repository);
    const tagCommit = await resolveTagCommit(executeFile, repository, tag);
    if (tagCommit !== commit) throw new TypeError("release commit mismatch");
    const existingNames = new Set(releaseAssetNames(release));
    for (const name of expectedNames) {
      if (existingNames.has(name)) {
        throw new TypeError(`Windows release asset already exists: ${name}`);
      }
    }
    await executeFile("gh-personal", [
      "release",
      "upload",
      tag,
      "--repo",
      repository,
      verified.paths.installer,
      verified.paths.blockmap,
      verified.paths.metadata,
    ]);
    uploaded = true;
    const uploadedRelease = await viewRelease(executeFile, tag, repository);
    const uploadedNames = new Set(releaseAssetNames(uploadedRelease));
    if (expectedNames.some((name) => !uploadedNames.has(name))) {
      throw new TypeError("Windows release upload is incomplete");
    }
    const record = Object.freeze({
      schemaVersion: 1,
      tag,
      version,
      commit,
      tagCommit,
      arch: "x64",
      status: "uploaded",
      authenticode: verified.authenticode,
      files,
    });
    if (input.record !== undefined) {
      await fileDependencies.writeFile(input.record, `${JSON.stringify(record, null, 2)}\n`, {
        flag: "w",
        mode: 0o600,
      });
    }
    return record;
  } catch (error) {
    if (input.record !== undefined) {
      const failureRecord = {
        schemaVersion: 1,
        tag,
        version,
        commit,
        arch: "x64",
        status: "failed",
        error:
          safeWindowsReleaseUploadMessage(error) ??
          safeWindowsReleaseVerificationMessage(error) ??
          "Windows release upload failed",
        uploaded,
      };
      try {
        await fileDependencies.writeFile(
          input.record,
          `${JSON.stringify(failureRecord, null, 2)}\n`,
          { flag: "w", mode: 0o600 },
        );
      } catch {}
    }
    throw error;
  }
}

function parseArguments(arguments_) {
  const parsed = { repo: defaultRepository };
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined || !name.startsWith("--") || value.startsWith("--")) {
      throw new TypeError("Windows release upload failed");
    }
    const key = name.slice(2);
    if (!["version", "directory", "commit", "authenticode", "repo", "record"].includes(key)) {
      throw new TypeError("Windows release upload failed");
    }
    if (Object.hasOwn(parsed, key) && key !== "repo") {
      throw new TypeError("Windows release upload failed");
    }
    parsed[key] = value;
  }
  return parsed;
}

async function main() {
  const result = await runWindowsReleaseUpload(parseArguments(process.argv.slice(2)));
  process.stdout.write(`Windows release uploaded ${result.tag}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message =
      safeWindowsReleaseUploadMessage(error) ??
      safeWindowsReleaseVerificationMessage(error) ??
      "Windows release upload failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
