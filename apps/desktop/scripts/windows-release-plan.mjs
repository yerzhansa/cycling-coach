import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  DESKTOP_UPDATER_CACHE_DIRECTORY,
  requireGenericFeedUrl,
  requireStableSemVer,
} from "./macos-release-plan.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalRepositoryRoot = resolve(scriptDirectory, "../../..");
const safeWindowsReleaseAssetMessagePattern =
  /^(?:duplicate|unknown|missing) Windows release asset: [-A-Za-z0-9@._]+$/u;
const safeWindowsReleasePlanMessages = new Set([
  "desktop release version must be stable SemVer",
  "release feed URL is invalid",
  "release commit must be a full lowercase SHA-1",
  "Windows release mode must be genesis or steady",
  "genesis Windows release must not name a baseline",
  "steady Windows release requires a lower stable baseline version",
  "release updater metadata is invalid",
  "release updater publisher name mismatch",
]);

export const WINDOWS_RELEASE_ARCH = "x64";
export const WINDOWS_RELEASE_PLATFORM = "win32";
export const WINDOWS_RELEASE_METADATA_NAME = "latest.yml";
export const WINDOWS_AUTHENTICODE_PENDING = "pending-w19";

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function freezeBuilderOptions(desktopRoot, version, feedUrl) {
  const publish = Object.freeze([
    Object.freeze({ provider: "generic", url: feedUrl, channel: "latest" }),
  ]);
  const target = Object.freeze([
    Object.freeze({ target: "nsis", arch: Object.freeze([WINDOWS_RELEASE_ARCH]) }),
  ]);
  const config = Object.freeze({
    extends: join(desktopRoot, "electron-builder.yml"),
    artifactName: `Enduragent-${version}-x64.\${ext}`,
    forceCodeSigning: true,
    extraMetadata: Object.freeze({ version, enduragentDesktopRelease: true }),
    publish,
    win: Object.freeze({ verifyUpdateCodeSignature: true, target }),
    nsis: Object.freeze({
      artifactName: `Enduragent-${version}-x64.\${ext}`,
      differentialPackage: true,
    }),
  });
  return Object.freeze({
    projectDir: desktopRoot,
    publish: "never",
    win: Object.freeze([`nsis:${WINDOWS_RELEASE_ARCH}`]),
    config,
  });
}

export function safeWindowsReleasePlanMessage(error) {
  return error instanceof TypeError &&
    (safeWindowsReleasePlanMessages.has(error.message) ||
      safeWindowsReleaseAssetMessagePattern.test(error.message))
    ? error.message
    : undefined;
}

export function requireReleaseCommit(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new TypeError("release commit must be a full lowercase SHA-1");
  }
  return value;
}

export function windowsReleaseArtifactNames(version) {
  const stableVersion = requireStableSemVer(version);
  const installer = `Enduragent-${stableVersion}-${WINDOWS_RELEASE_ARCH}.exe`;
  return Object.freeze({
    installer,
    blockmap: `${installer}.blockmap`,
    metadata: WINDOWS_RELEASE_METADATA_NAME,
  });
}

export function windowsReleaseAssetNames(version) {
  return Object.freeze(Object.values(windowsReleaseArtifactNames(version)).sort());
}

export function assertKnownWindowsReleaseAssets(names, version) {
  if (!Array.isArray(names)) throw new TypeError("unknown Windows release asset: latest.yml");
  const expected = windowsReleaseAssetNames(version);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate !== undefined) throw new TypeError(`duplicate Windows release asset: ${duplicate}`);
  const seen = new Set();
  for (const name of names) {
    seen.add(name);
    if (!expected.includes(name)) throw new TypeError(`unknown Windows release asset: ${name}`);
  }
  for (const name of expected) {
    if (!seen.has(name)) throw new TypeError(`missing Windows release asset: ${name}`);
  }
  return expected;
}

export function parseWindowsReleaseUpdaterMetadata(bytes, options = {}) {
  let metadata;
  try {
    const source =
      typeof bytes === "string"
        ? bytes
        : bytes instanceof Uint8Array
          ? Buffer.from(bytes).toString("utf8")
          : undefined;
    if (source === undefined) throw new TypeError();
    metadata = parse(source);
  } catch {
    throw new TypeError("release updater metadata is invalid");
  }
  const keys = ["provider", "url", "channel", "updaterCacheDirName"];
  if (exactObject(metadata) && Object.hasOwn(metadata, "publisherName")) keys.push("publisherName");
  if (
    !exactObject(metadata) ||
    !hasExactKeys(metadata, keys) ||
    metadata.provider !== "generic" ||
    metadata.channel !== "latest" ||
    metadata.updaterCacheDirName !== DESKTOP_UPDATER_CACHE_DIRECTORY ||
    (Object.hasOwn(metadata, "publisherName") &&
      (typeof metadata.publisherName !== "string" ||
        metadata.publisherName.length === 0 ||
        metadata.publisherName !== metadata.publisherName.trim()))
  ) {
    throw new TypeError("release updater metadata is invalid");
  }
  let url;
  try {
    url = requireGenericFeedUrl(metadata.url);
  } catch {
    throw new TypeError("release updater metadata is invalid");
  }
  if (
    Object.hasOwn(options, "expectedPublisherName") &&
    options.expectedPublisherName !== metadata.publisherName
  ) {
    throw new TypeError("release updater publisher name mismatch");
  }
  const result = {
    provider: "generic",
    url,
    channel: "latest",
    updaterCacheDirName: DESKTOP_UPDATER_CACHE_DIRECTORY,
  };
  if (Object.hasOwn(metadata, "publisherName")) result.publisherName = metadata.publisherName;
  return Object.freeze(result);
}

export async function readWindowsReleaseVersion(options = {}, dependencies = {}) {
  const repositoryRoot = options.repositoryRoot ?? canonicalRepositoryRoot;
  if (!isAbsolute(repositoryRoot)) throw new TypeError("repository root must be absolute");
  const desktopRoot = options.desktopRoot ?? join(repositoryRoot, "apps/desktop");
  if (!isAbsolute(desktopRoot)) throw new TypeError("desktop root must be absolute");
  const read = dependencies.readFile ?? readFile;
  let manifest;
  try {
    manifest = JSON.parse(await read(join(desktopRoot, "package.json"), "utf8"));
  } catch {
    throw new TypeError("desktop release manifest is invalid");
  }
  if (!exactObject(manifest) || !Object.hasOwn(manifest, "version")) {
    throw new TypeError("desktop release manifest is invalid");
  }
  return requireStableSemVer(manifest.version);
}

export function createWindowsReleasePlan(input) {
  const version = requireStableSemVer(input.version);
  const commit = requireReleaseCommit(input.commit);
  const feedUrl = requireGenericFeedUrl(input.feedUrl);
  if (input.mode !== "genesis" && input.mode !== "steady") {
    throw new TypeError("Windows release mode must be genesis or steady");
  }
  let baselineVersion = null;
  if (input.mode === "genesis") {
    if (input.baselineVersion !== undefined) {
      throw new TypeError("genesis Windows release must not name a baseline");
    }
  } else {
    try {
      baselineVersion = requireStableSemVer(input.baselineVersion);
    } catch {
      throw new TypeError("steady Windows release requires a lower stable baseline version");
    }
    if (compareStableVersions(baselineVersion, version) >= 0) {
      throw new TypeError("steady Windows release requires a lower stable baseline version");
    }
  }
  const repositoryRoot = input.repositoryRoot ?? canonicalRepositoryRoot;
  if (!isAbsolute(repositoryRoot)) throw new TypeError("repository root must be absolute");
  const desktopRoot = input.desktopRoot ?? join(repositoryRoot, "apps/desktop");
  if (!isAbsolute(desktopRoot)) throw new TypeError("desktop root must be absolute");
  const artifactNames = windowsReleaseArtifactNames(version);
  const assetNames = windowsReleaseAssetNames(version);
  const updaterMetadata = Object.freeze({
    provider: "generic",
    url: feedUrl,
    channel: "latest",
    updaterCacheDirName: DESKTOP_UPDATER_CACHE_DIRECTORY,
  });
  return Object.freeze({
    version,
    commit,
    tag: `enduragent-desktop@${version}`,
    platform: WINDOWS_RELEASE_PLATFORM,
    arch: WINDOWS_RELEASE_ARCH,
    mode: input.mode,
    baselineVersion,
    feedUrl,
    artifactNames,
    assetNames,
    updaterMetadata,
    authenticode: WINDOWS_AUTHENTICODE_PENDING,
    builderOptions: freezeBuilderOptions(desktopRoot, version, feedUrl),
  });
}
