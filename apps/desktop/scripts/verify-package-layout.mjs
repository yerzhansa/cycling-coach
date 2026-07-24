import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { extractFile, listPackage, statFile, uncache } from "@electron/asar";
import { parse } from "yaml";
import {
  DESKTOP_UPDATER_CACHE_DIRECTORY,
  requireGenericFeedUrl,
  requireStableCalVer,
} from "./macos-release-plan.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");
const canonicalApplication = join(canonicalDesktopRoot, "dist/mac-arm64/Enduragent.app");
const requiredAsarFiles = [
  "out/main/index.js",
  "out/main/daemon-utility.js",
  "out/preload/index.cjs",
  "out/renderer/index.html",
  "out/renderer/tray.html",
  "package.json",
  "resources/self-test/matrix.json",
  "resources/self-test/matrix.sha256",
];
const requiredFilePatterns = [
  "out/**",
  "package.json",
  "!**/*.map",
  "!**/.env*",
  "!**/{test,tests,__tests__,fixture,fixtures,dev-fixture,dev-fixtures}/**",
  "!**/*.{test,spec}.{js,cjs,mjs,ts,cts,mts,jsx,tsx}",
  "!**/vitest.config.{js,cjs,mjs,ts,cts,mts}",
  "!**/vitest.workspace.{js,cjs,mjs,ts,cts,mts}",
  "!**/node_modules/vitest/**",
  "!**/node_modules/@vitest/**",
];
const reservedResourceNames = new Set([
  "app.asar",
  "app.asar.unpacked",
  "app-update.yml",
  "electron.icns",
  "en.lproj",
]);
const forbiddenDirectoryNames = new Set([
  "test",
  "tests",
  "__tests__",
  "fixture",
  "fixtures",
  "dev-fixture",
  "dev-fixtures",
  "vitest",
  "@vitest",
]);
const knownSecretMarkers = [
  "desktop-sentinel-model-key",
  "private-token-marker",
  "sentinel-anthropic-api-key",
  "sentinel-openai-api-key",
  "sentinel-google-generative-ai-api-key",
  "sentinel-deepseek-api-key",
  "sentinel-alibaba-api-key",
  "sentinel-minimax-api-key",
  "sentinel-moonshot-api-key",
  "sentinel-zai-api-key",
  "sentinel-openrouter-api-key",
  "sentinel-llm-api-key",
  "sentinel-intervals-api-key",
  "sentinel-telegram-bot-token",
  "sentinel-my-llm-key",
  "synthetic-secret",
];
const removedMainManifestKeys = new Set([
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
]);

class PackageLayoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "PackageLayoutError";
  }
}

function fail(message, path) {
  const suffix = path === undefined ? "" : `: ${displayPath(path)}`;
  throw new PackageLayoutError(`${message}${suffix}`);
}

function displayPath(path) {
  const printable = Array.from(String(path).replaceAll("\\", "/"), (character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code < 32 || code === 127) ? "?" : character;
  }).join("");
  const normalized = printable.replace(/^\/+/u, "");
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 177)}...`;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contained(root, path) {
  const relation = relative(root, path);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function nested(left, right) {
  return left !== right && contained(left, right);
}

async function safeLstat(path, label) {
  try {
    return await lstat(path);
  } catch {
    fail("missing or unreadable package entry", label);
  }
}

async function safeReadFile(path, label) {
  try {
    return await readFile(path);
  } catch {
    fail("missing or unreadable package file", label);
  }
}

async function safeReadDirectory(path, label) {
  try {
    return await readdir(path);
  } catch {
    fail("missing or unreadable package directory", label);
  }
}

function assertRegularFile(stat, label) {
  if (stat.isSymbolicLink()) fail("symbolic links are forbidden", label);
  if (!stat.isFile()) fail("expected a regular file", label);
}

function assertDirectory(stat, label) {
  if (stat.isSymbolicLink()) fail("symbolic links are forbidden", label);
  if (!stat.isDirectory()) fail("expected a directory", label);
}

function validateRelativePath(path, label) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/u, "");
  const segments = normalized.split("/");
  if (
    normalized.length === 0 ||
    normalized.includes("\u0000") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    fail("invalid relative package path", label);
  }
  return normalized;
}

function forbiddenPathReason(path) {
  const lower = path.toLowerCase();
  const segments = lower.split("/");
  const base = segments.at(-1) ?? "";
  if (base.endsWith(".map")) return "source map";
  if (base.startsWith(".env")) return "environment file";
  if (segments.some((segment) => forbiddenDirectoryNames.has(segment))) {
    return "test or fixture directory";
  }
  if (/(?:^|\.)(?:test|spec)\./u.test(base)) return "test or spec source";
  if (/^vitest\.(?:config|workspace)\./u.test(base)) return "Vitest configuration";
  return undefined;
}

function inspectPath(path, label) {
  const reason = forbiddenPathReason(path);
  if (reason !== undefined) fail(`forbidden ${reason}`, label);
}

function inspectContents(bytes, label) {
  const text = bytes.toString("latin1").toLowerCase();
  if (
    knownSecretMarkers.some((marker) => text.includes(marker)) ||
    /obviously-fake-[a-z0-9-]{1,96}key\b/u.test(text) ||
    /(?:^|[^a-z0-9])sk-secret(?:[^a-z0-9]|$)/u.test(text)
  ) {
    fail("known plaintext secret marker", label);
  }
}

function fileSet(value) {
  if (!exactObject(value) || typeof value.from !== "string" || typeof value.to !== "string") {
    fail("invalid builder FileSet");
  }
  return value;
}

function outputChild(desktopRoot, outputRoot, source, label) {
  if (isAbsolute(source)) fail("builder source must be relative", label);
  const resolved = resolve(desktopRoot, source);
  if (resolved === outputRoot || !contained(outputRoot, resolved)) {
    fail("builder source must be inside its output directory", label);
  }
  return resolved;
}

export async function readBuilderAuthority(desktopRoot = canonicalDesktopRoot) {
  if (!isAbsolute(desktopRoot)) fail("desktop root must be absolute");
  const configPath = join(desktopRoot, "electron-builder.yml");
  const bytes = await safeReadFile(configPath, "electron-builder.yml");
  let config;
  try {
    config = parse(bytes.toString("utf8"));
  } catch {
    fail("invalid builder configuration", "electron-builder.yml");
  }
  if (
    !exactObject(config) ||
    config.asar !== true ||
    !Array.isArray(config.electronLanguages) ||
    config.electronLanguages.length !== 1 ||
    config.electronLanguages[0] !== "en" ||
    !exactObject(config.directories) ||
    config.directories.output !== "dist" ||
    !Array.isArray(config.files) ||
    !Array.isArray(config.extraResources)
  ) {
    fail("invalid builder packaging authority", "electron-builder.yml");
  }
  if (
    config.extraFiles !== undefined ||
    (exactObject(config.mac) && config.mac.extraFiles !== undefined)
  ) {
    fail("alternate builder copy surfaces are forbidden", "electron-builder.yml");
  }

  const patternEntries = config.files.filter((entry) => typeof entry === "string");
  if (
    patternEntries.length !== requiredFilePatterns.length ||
    new Set(patternEntries).size !== patternEntries.length ||
    requiredFilePatterns.some((pattern) => !patternEntries.includes(pattern))
  ) {
    fail("builder file exclusions are incomplete", "electron-builder.yml");
  }

  const configuredFileSets = config.files.filter((entry) => typeof entry !== "string").map(fileSet);
  const resourceSets = configuredFileSets.filter(
    (entry) => entry.from === "resources" && entry.to === "resources",
  );
  if (
    resourceSets.length !== 1 ||
    !Array.isArray(resourceSets[0].filter) ||
    resourceSets[0].filter.length !== 2 ||
    !resourceSets[0].filter.includes("trayTemplate.png") ||
    !resourceSets[0].filter.includes("trayTemplate@2x.png")
  ) {
    fail("builder runtime resources are incomplete", "electron-builder.yml");
  }
  const asarSets = configuredFileSets.filter((entry) => entry.to === ".");
  if (configuredFileSets.length !== 2 || asarSets.length !== 1) {
    fail("builder ASAR staging authority is ambiguous", "electron-builder.yml");
  }
  if (Object.keys(asarSets[0]).some((key) => !["from", "to"].includes(key))) {
    fail("builder ASAR staging authority is filtered", "electron-builder.yml");
  }
  if (config.extraResources.length !== 1) {
    fail("builder external staging authority is ambiguous", "electron-builder.yml");
  }
  const externalSet = fileSet(config.extraResources[0]);
  if (
    externalSet.to !== "." ||
    Object.keys(externalSet).some((key) => !["from", "to"].includes(key))
  ) {
    fail("builder external staging authority is filtered", "electron-builder.yml");
  }

  const outputRoot = resolve(desktopRoot, "dist");
  const asarSourceRoot = outputChild(
    desktopRoot,
    outputRoot,
    asarSets[0].from,
    "electron-builder.yml/files",
  );
  const externalSourceRoot = outputChild(
    desktopRoot,
    outputRoot,
    externalSet.from,
    "electron-builder.yml/extraResources",
  );
  if (
    asarSourceRoot === externalSourceRoot ||
    nested(asarSourceRoot, externalSourceRoot) ||
    nested(externalSourceRoot, asarSourceRoot)
  ) {
    fail("builder staging roots must be disjoint", "electron-builder.yml");
  }
  return { asarSourceRoot, externalSourceRoot };
}

async function collectTree(root, labelRoot, scan) {
  const rootStat = await safeLstat(root, labelRoot);
  assertDirectory(rootStat, labelRoot);
  const tree = new Map();

  async function visit(directory, relativeRoot) {
    const names = (await safeReadDirectory(directory, labelRoot)).sort();
    for (const name of names) {
      const relativePath = validateRelativePath(
        relativeRoot.length === 0 ? name : `${relativeRoot}/${name}`,
        labelRoot,
      );
      const label = `${labelRoot}/${relativePath}`;
      if (scan) inspectPath(relativePath, label);
      const absolutePath = join(directory, name);
      const stat = await safeLstat(absolutePath, label);
      if (stat.isSymbolicLink()) fail("symbolic links are forbidden", label);
      if (stat.isDirectory()) {
        tree.set(relativePath, { type: "directory" });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) fail("unsupported package entry type", label);
      const bytes = await safeReadFile(absolutePath, label);
      if (scan) inspectContents(bytes, label);
      tree.set(relativePath, { type: "file", bytes });
    }
  }

  await visit(root, "");
  return tree;
}

function safeAsarList(archivePath) {
  try {
    return listPackage(archivePath);
  } catch {
    fail("invalid ASAR archive", "Contents/Resources/app.asar");
  }
}

function safeAsarStat(archivePath, path) {
  try {
    return statFile(archivePath, path, false);
  } catch {
    fail("invalid ASAR entry", `app.asar/${path}`);
  }
}

function safeAsarExtract(archivePath, path) {
  try {
    return extractFile(archivePath, path, false);
  } catch {
    fail("unreadable ASAR entry", `app.asar/${path}`);
  }
}

function collectAsar(archivePath) {
  uncache(archivePath);
  const tree = new Map();
  for (const listedPath of safeAsarList(archivePath)) {
    const path = validateRelativePath(listedPath, "Contents/Resources/app.asar");
    if (tree.has(path)) fail("duplicate ASAR entry", `app.asar/${path}`);
    const label = `app.asar/${path}`;
    inspectPath(path, label);
    const metadata = safeAsarStat(archivePath, path);
    if ("link" in metadata) fail("symbolic links are forbidden", label);
    if ("files" in metadata) {
      tree.set(path, { type: "directory", unpacked: metadata.unpacked === true });
      continue;
    }
    let bytes;
    if (metadata.unpacked !== true) {
      bytes = safeAsarExtract(archivePath, path);
      inspectContents(bytes, label);
    }
    tree.set(path, { type: "file", unpacked: metadata.unpacked === true, bytes });
  }
  return tree;
}

async function validateUnpackedTree(resourcesRoot, asar, present) {
  const expected = new Map();
  for (const [path, entry] of asar) {
    if (entry.type !== "file" || entry.unpacked !== true) continue;
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expected.set(segments.slice(0, index).join("/"), { type: "directory" });
    }
    expected.set(path, { type: "file" });
  }
  if (!present) {
    if (expected.size > 0) {
      fail("declared unpacked resources are missing", "Contents/Resources/app.asar.unpacked");
    }
    return;
  }
  const actual = await collectTree(
    join(resourcesRoot, "app.asar.unpacked"),
    "Contents/Resources/app.asar.unpacked",
    true,
  );
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = [...actual.keys()].sort();
  if (
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some((path, index) => path !== actualPaths[index])
  ) {
    fail("undeclared unpacked resource", "Contents/Resources/app.asar.unpacked");
  }
  for (const path of expectedPaths) {
    if (expected.get(path).type !== actual.get(path).type) {
      fail("unpacked resource type differs from ASAR", `app.asar.unpacked/${path}`);
    }
  }
}

function compareStagedTree(expected, actual, actualRoot) {
  const expectedPaths = [...expected.keys()].sort();
  const actualPaths = [...actual.keys()].sort();
  if (
    expectedPaths.length !== actualPaths.length ||
    expectedPaths.some((path, index) => path !== actualPaths[index])
  ) {
    fail("packaged external resource tree differs from staging", actualRoot);
  }
  for (const path of expectedPaths) {
    const expectedEntry = expected.get(path);
    const actualEntry = actual.get(path);
    if (expectedEntry.type !== actualEntry.type) {
      fail("packaged external resource type differs from staging", `${actualRoot}/${path}`);
    }
    if (expectedEntry.type === "file" && !expectedEntry.bytes.equals(actualEntry.bytes)) {
      fail("packaged external resource bytes differ from staging", `${actualRoot}/${path}`);
    }
  }
}

function compareAsarStaging(expected, asar) {
  for (const [path, expectedEntry] of expected) {
    const actualEntry = asar.get(path);
    if (
      actualEntry === undefined ||
      actualEntry.type !== expectedEntry.type ||
      actualEntry.unpacked === true
    ) {
      fail("ASAR staging entry is missing or unpacked", `app.asar/${path}`);
    }
    if (
      expectedEntry.type === "file" &&
      (!Buffer.isBuffer(actualEntry.bytes) || !expectedEntry.bytes.equals(actualEntry.bytes))
    ) {
      fail("ASAR staging bytes differ from source", `app.asar/${path}`);
    }
  }
}

function parseManifest(bytes, label) {
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("packaged manifest is invalid", label);
  }
  if (!exactObject(manifest) || manifest.main !== "out/main/index.js") {
    fail("packaged manifest has an invalid main entry", label);
  }
  return manifest;
}

function validateManifest(asar, sourceBytes, release) {
  const packagedBytes = asar.get("package.json").bytes;
  const source = parseManifest(sourceBytes, "package.json");
  const packaged = parseManifest(packagedBytes, "app.asar/package.json");
  if (Object.hasOwn(source, "enduragentDesktopRelease")) {
    fail("source manifest contains a release marker", "package.json");
  }
  const expected = structuredClone(source);
  if (release !== undefined) {
    expected.version = release.version;
    expected.enduragentDesktopRelease = true;
  }
  let transformed = release !== undefined;
  for (const key of Object.keys(expected)) {
    if (key.startsWith("_") || removedMainManifestKeys.has(key)) {
      delete expected[key];
      transformed = true;
    }
  }
  if (
    exactObject(expected.dependencies) &&
    !Object.keys(expected.dependencies).some((key) => key.startsWith("babel")) &&
    Object.hasOwn(expected, "babel")
  ) {
    delete expected.babel;
    transformed = true;
  }
  const expectedBytes = transformed ? Buffer.from(JSON.stringify(expected, null, 2)) : sourceBytes;
  if (!expectedBytes.equals(packagedBytes) || !isDeepStrictEqual(packaged, expected)) {
    if (release === undefined) {
      fail("ordinary packaged manifest differs from source", "app.asar/package.json");
    }
    fail("release packaged manifest has unexpected drift", "app.asar/package.json");
  }
}

function validateRequiredAsarFiles(asar, sourceManifest, release) {
  for (const path of requiredAsarFiles) {
    const entry = asar.get(path);
    if (entry === undefined || entry.type !== "file" || entry.unpacked === true) {
      fail("required runtime file is missing from ASAR", `app.asar/${path}`);
    }
  }
  for (const path of asar.keys()) {
    if (path.split("/").at(-1) === "self-test-runner.cjs") {
      fail("self-test runner must remain external", `app.asar/${path}`);
    }
  }

  validateManifest(asar, sourceManifest, release);

  const matrix = asar.get("resources/self-test/matrix.json").bytes;
  const checksum = asar.get("resources/self-test/matrix.sha256").bytes;
  const expectedChecksum = `${createHash("sha256").update(matrix).digest("hex")}  matrix.json\n`;
  if (checksum.toString("utf8") !== expectedChecksum) {
    fail("self-test checksum does not match its matrix", "app.asar/resources/self-test");
  }
}

function validateAppUpdate(bytes, release) {
  let update;
  try {
    update = parse(bytes.toString("utf8"));
  } catch {
    fail("invalid release app-update.yml", "Contents/Resources/app-update.yml");
  }
  const expected = {
    provider: "generic",
    url: release.feedUrl,
    channel: "latest",
    updaterCacheDirName: DESKTOP_UPDATER_CACHE_DIRECTORY,
  };
  if (!exactObject(update) || !isDeepStrictEqual(update, expected)) {
    fail("invalid release app-update.yml", "Contents/Resources/app-update.yml");
  }
}

async function validateResourceEnvelope(resourcesRoot, externalSource, release) {
  const names = (await safeReadDirectory(resourcesRoot, "Contents/Resources")).sort();
  const sourceTopLevel = new Set([...externalSource.keys()].map((path) => path.split("/")[0]));
  for (const name of sourceTopLevel) {
    if (reservedResourceNames.has(name)) {
      fail("external resources collide with reserved package entries", "dist/extra-resources");
    }
  }
  const expected = new Set(["app.asar", "electron.icns", "en.lproj", ...sourceTopLevel]);
  if (release !== undefined) expected.add("app-update.yml");
  if (names.includes("app.asar.unpacked")) expected.add("app.asar.unpacked");
  if (names.length !== expected.size || names.some((name) => !expected.has(name))) {
    fail("undeclared package resource", "Contents/Resources");
  }

  const iconPath = join(resourcesRoot, "electron.icns");
  const iconLabel = "Contents/Resources/electron.icns";
  const iconStat = await safeLstat(iconPath, iconLabel);
  assertRegularFile(iconStat, iconLabel);
  inspectContents(await safeReadFile(iconPath, iconLabel), iconLabel);
  await collectTree(join(resourcesRoot, "en.lproj"), "Contents/Resources/en.lproj", true);
  if (release !== undefined) {
    const updatePath = join(resourcesRoot, "app-update.yml");
    const updateLabel = "Contents/Resources/app-update.yml";
    const updateStat = await safeLstat(updatePath, updateLabel);
    assertRegularFile(updateStat, updateLabel);
    const updateBytes = await safeReadFile(updatePath, updateLabel);
    inspectContents(updateBytes, updateLabel);
    validateAppUpdate(updateBytes, release);
  }
}

export async function verifyPackageLayout(application, options = {}) {
  if (!isAbsolute(application) || !application.endsWith(".app")) {
    fail("application path must be one absolute .app path");
  }
  const desktopRoot = options.desktopRoot ?? canonicalDesktopRoot;
  if (!isAbsolute(desktopRoot)) fail("desktop root must be absolute");
  let release;
  if (options.release !== undefined) {
    if (
      !exactObject(options.release) ||
      Object.keys(options.release).length !== 2 ||
      !Object.hasOwn(options.release, "version") ||
      !Object.hasOwn(options.release, "feedUrl")
    ) {
      fail("invalid release package-layout options");
    }
    release = {
      version: requireStableCalVer(options.release.version),
      feedUrl: requireGenericFeedUrl(options.release.feedUrl),
    };
  }

  try {
    const applicationStat = await safeLstat(application, "Enduragent.app");
    assertDirectory(applicationStat, "Enduragent.app");
    const contentsRoot = join(application, "Contents");
    const contentsStat = await safeLstat(contentsRoot, "Contents");
    assertDirectory(contentsStat, "Contents");
    const resourcesRoot = join(contentsRoot, "Resources");
    const resourcesStat = await safeLstat(resourcesRoot, "Contents/Resources");
    assertDirectory(resourcesStat, "Contents/Resources");

    const authority = await readBuilderAuthority(desktopRoot);
    const [asarStaging, externalSource, sourceManifest] = await Promise.all([
      collectTree(authority.asarSourceRoot, "dist/ASAR-staging", false),
      collectTree(authority.externalSourceRoot, "dist/extra-resources", false),
      safeReadFile(join(desktopRoot, "package.json"), "package.json"),
    ]);
    await validateResourceEnvelope(resourcesRoot, externalSource, release);

    const archivePath = join(resourcesRoot, "app.asar");
    const archiveStat = await safeLstat(archivePath, "Contents/Resources/app.asar");
    assertRegularFile(archiveStat, "Contents/Resources/app.asar");
    const asar = collectAsar(archivePath);
    validateRequiredAsarFiles(asar, sourceManifest, release);
    compareAsarStaging(asarStaging, asar);

    const externalPackaged = new Map();
    for (const topLevel of new Set([...externalSource.keys()].map((path) => path.split("/")[0]))) {
      const subtree = await collectTree(
        join(resourcesRoot, topLevel),
        `Contents/Resources/${topLevel}`,
        true,
      );
      externalPackaged.set(topLevel, { type: "directory" });
      for (const [path, entry] of subtree) {
        externalPackaged.set(`${topLevel}/${path}`, entry);
      }
    }
    compareStagedTree(externalSource, externalPackaged, "Contents/Resources");
    const runner = externalPackaged.get("self-test/self-test-runner.cjs");
    if (runner === undefined || runner.type !== "file") {
      fail(
        "external self-test runner is missing",
        "Contents/Resources/self-test/self-test-runner.cjs",
      );
    }

    const unpackedPresent = (await safeReadDirectory(resourcesRoot, "Contents/Resources")).includes(
      "app.asar.unpacked",
    );
    await validateUnpackedTree(resourcesRoot, asar, unpackedPresent);
  } catch (error) {
    if (error instanceof PackageLayoutError) throw error;
    fail("package layout verification failed");
  }
}

function applicationArgument(args) {
  if (args.length === 0) return canonicalApplication;
  if (args.length !== 1 || !isAbsolute(args[0]) || !args[0].endsWith(".app")) {
    fail("expected zero arguments or one absolute .app path");
  }
  return args[0];
}

async function main() {
  try {
    await verifyPackageLayout(applicationArgument(process.argv.slice(2)));
    process.stdout.write("package layout verified\n");
  } catch (error) {
    const message =
      error instanceof PackageLayoutError ? error.message : "package layout verification failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
