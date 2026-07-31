import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";
import { readCyclingCoachVersion, releaseArtifactNames } from "./macos-release-plan.mjs";

const localRequire = createRequire(import.meta.url);
const supportedElectronBuilderVersion = "26.15.3";
const execFileAsync = promisify(execFile);

class MacosReleaseVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MacosReleaseVerificationError";
  }
}

function fail(message) {
  throw new MacosReleaseVerificationError(message);
}

async function executeSystemFile(executable, arguments_) {
  await execFileAsync(executable, [...arguments_], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
}

async function runSystemVerification(executeFile, executable, arguments_, failureMessage) {
  try {
    await executeFile(executable, arguments_);
  } catch {
    fail(failureMessage);
  }
}

async function verifyMacosDmgSignature(dmgPath, executeFile) {
  await runSystemVerification(
    executeFile,
    "/usr/bin/codesign",
    ["--verify", "--verbose=2", dmgPath],
    "macOS DMG signature verification failed",
  );
}

async function verifyMacosDmgNotarization(dmgPath, executeFile) {
  await runSystemVerification(
    executeFile,
    "/usr/bin/xcrun",
    ["stapler", "validate", "-v", dmgPath],
    "macOS DMG staple verification failed",
  );
  await runSystemVerification(
    executeFile,
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
    "macOS DMG Gatekeeper verification failed",
  );
}

export async function verifyMacosApplication(application, overrides = {}) {
  if (!isAbsolute(application)) fail("application path must be absolute");
  const executeFile = overrides.executeFile ?? executeSystemFile;
  await runSystemVerification(
    executeFile,
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", application],
    "macOS application signature verification failed",
  );
  await runSystemVerification(
    executeFile,
    "/usr/bin/xcrun",
    ["stapler", "validate", "-v", application],
    "macOS application staple verification failed",
  );
  await runSystemVerification(
    executeFile,
    "/usr/sbin/spctl",
    ["--assess", "--type", "execute", "--verbose=4", application],
    "macOS application Gatekeeper verification failed",
  );
}

export async function verifyMacosDmg(dmgPath, overrides = {}) {
  if (!isAbsolute(dmgPath)) fail("DMG path must be absolute");
  const executeFile = overrides.executeFile ?? executeSystemFile;
  await verifyMacosDmgSignature(dmgPath, executeFile);
  await verifyMacosDmgNotarization(dmgPath, executeFile);
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function installedBuildBlockMap(inputPath, compression, outputPath) {
  let electronBuilderManifest;
  let blockMapPackageManifest;
  let blockMapModule;
  try {
    electronBuilderManifest = localRequire("electron-builder/package.json");
    const builderRequire = createRequire(localRequire.resolve("electron-builder"));
    blockMapPackageManifest = builderRequire("app-builder-lib/package.json");
    blockMapModule = builderRequire("app-builder-lib/out/targets/blockmap/blockmap");
  } catch {
    fail("electron-builder blockmap implementation is unavailable");
  }
  if (
    electronBuilderManifest.version !== supportedElectronBuilderVersion ||
    blockMapPackageManifest.version !== supportedElectronBuilderVersion ||
    typeof blockMapModule.buildBlockMap !== "function"
  ) {
    fail("electron-builder blockmap implementation is unsupported");
  }
  return blockMapModule.buildBlockMap(inputPath, compression, outputPath);
}

async function readRegularFile(path, label, dependencies) {
  let stat;
  try {
    stat = await dependencies.lstat(path);
  } catch {
    fail(`missing ${label}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`invalid ${label}`);
  let bytes;
  try {
    bytes = await dependencies.readFile(path);
  } catch {
    fail(`unreadable ${label}`);
  }
  if (bytes.length === 0) fail(`empty ${label}`);
  return bytes;
}

function parseMetadata(bytes) {
  let metadata;
  try {
    metadata = parse(bytes.toString("utf8"));
  } catch {
    fail("invalid latest-mac.yml");
  }
  if (
    !exactObject(metadata) ||
    !hasExactKeys(metadata, ["version", "files", "path", "sha512", "releaseDate"]) ||
    !Array.isArray(metadata.files) ||
    metadata.files.length !== 2 ||
    !exactObject(metadata.files[0]) ||
    !hasExactKeys(metadata.files[0], ["url", "sha512", "size"]) ||
    !exactObject(metadata.files[1]) ||
    !hasExactKeys(metadata.files[1], ["url", "sha512", "size"])
  ) {
    fail("invalid latest-mac.yml");
  }
  return metadata;
}

function validateReleaseDate(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function metadataFileMatches(file, name, sha512, size) {
  return (
    file.url === name &&
    file.sha512 === sha512 &&
    file.size === size &&
    Number.isSafeInteger(file.size) &&
    file.size > 0
  );
}

function isExpectedTemporaryDirectory(path, prefix) {
  return (
    isAbsolute(path) &&
    dirname(path) === dirname(prefix) &&
    path !== prefix &&
    basename(path).startsWith(basename(prefix))
  );
}

async function regenerateBlockmap(zipPath, dependencies) {
  const temporaryPrefix = join(dependencies.tmpdir(), "enduragent-blockmap-");
  let temporaryDirectory;
  let regenerated;
  try {
    const candidate = await dependencies.mkdtemp(temporaryPrefix);
    if (!isExpectedTemporaryDirectory(candidate, temporaryPrefix)) {
      fail("invalid temporary ZIP blockmap directory");
    }
    temporaryDirectory = candidate;
    const temporaryPath = join(temporaryDirectory, "expected.zip.blockmap");
    await dependencies.buildBlockMap(zipPath, "gzip", temporaryPath);
    regenerated = await readRegularFile(temporaryPath, "regenerated ZIP blockmap", dependencies);
  } catch {
    fail("unable to regenerate ZIP blockmap");
  } finally {
    if (temporaryDirectory !== undefined) {
      try {
        await dependencies.rm(temporaryDirectory, { recursive: true, force: true });
      } catch {
        fail("unable to clean regenerated ZIP blockmap");
      }
    }
  }
  return regenerated;
}

export async function verifyMacosReleaseArtifacts(artifactDirectory, options = {}, overrides = {}) {
  if (!isAbsolute(artifactDirectory)) fail("artifact directory must be absolute");
  const dependencies = {
    lstat: overrides.lstat ?? lstat,
    mkdtemp: overrides.mkdtemp ?? mkdtemp,
    readFile: overrides.readFile ?? readFile,
    readdir: overrides.readdir ?? readdir,
    rm: overrides.rm ?? rm,
    tmpdir: overrides.tmpdir ?? tmpdir,
    buildBlockMap: overrides.buildBlockMap ?? installedBuildBlockMap,
    executeFile: overrides.executeFile ?? executeSystemFile,
    verifySignature: overrides.verifySignature,
    verifyNotarization: overrides.verifyNotarization,
  };
  const version = await readCyclingCoachVersion({
    repositoryRoot: options.repositoryRoot,
    readFile: options.readVersionFile,
  });
  const names = releaseArtifactNames(version);
  let directoryStat;
  try {
    directoryStat = await dependencies.lstat(artifactDirectory);
  } catch {
    fail("release artifact directory is missing");
  }
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    fail("release artifact directory is invalid");
  }
  let entries;
  try {
    entries = await dependencies.readdir(artifactDirectory);
  } catch {
    fail("release artifact directory is missing");
  }
  const expectedNames = Object.values(names).sort();
  const actualNames = [...entries].sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail("release artifact envelope differs");
  }

  const paths = Object.freeze({
    dmg: join(artifactDirectory, names.dmg),
    zip: join(artifactDirectory, names.zip),
    blockmap: join(artifactDirectory, names.blockmap),
    metadata: join(artifactDirectory, names.metadata),
  });
  const [dmg, zip, blockmap, metadataBytes] = await Promise.all([
    readRegularFile(paths.dmg, "DMG artifact", dependencies),
    readRegularFile(paths.zip, "ZIP artifact", dependencies),
    readRegularFile(paths.blockmap, "ZIP blockmap", dependencies),
    readRegularFile(paths.metadata, "latest-mac.yml", dependencies),
  ]);
  const metadata = parseMetadata(metadataBytes);
  const zipSha512 = createHash("sha512").update(zip).digest("base64");
  const dmgSha512 = createHash("sha512").update(dmg).digest("base64");
  const zipFile = metadata.files[0];
  const dmgFile = metadata.files[1];
  if (
    metadata.version !== version ||
    metadata.path !== names.zip ||
    metadata.sha512 !== zipSha512 ||
    !validateReleaseDate(metadata.releaseDate) ||
    !metadataFileMatches(zipFile, names.zip, zipSha512, zip.length) ||
    !metadataFileMatches(dmgFile, names.dmg, dmgSha512, dmg.length)
  ) {
    fail("latest-mac.yml does not match the release artifacts");
  }

  const regeneratedBlockmap = await regenerateBlockmap(paths.zip, dependencies);
  if (!blockmap.equals(regeneratedBlockmap)) fail("ZIP blockmap does not match the ZIP artifact");

  const artifacts = Object.freeze({
    version,
    names,
    paths,
    sizes: Object.freeze({
      dmg: dmg.length,
      zip: zip.length,
      blockmap: blockmap.length,
    }),
    dmgSha512,
    zipSha512,
  });
  const verifySignature =
    dependencies.verifySignature ??
    ((verifiedArtifacts) =>
      verifyMacosDmgSignature(verifiedArtifacts.paths.dmg, dependencies.executeFile));
  const verifyNotarization =
    dependencies.verifyNotarization ??
    ((verifiedArtifacts) =>
      verifyMacosDmgNotarization(verifiedArtifacts.paths.dmg, dependencies.executeFile));
  await verifySignature(artifacts);
  await verifyNotarization(artifacts);
  return artifacts;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !isAbsolute(args[0])) {
    fail("expected one absolute release artifact directory");
  }
  await verifyMacosReleaseArtifacts(args[0]);
  process.stdout.write("macOS release artifacts verified\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message =
      error instanceof MacosReleaseVerificationError
        ? error.message
        : "macOS release verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
