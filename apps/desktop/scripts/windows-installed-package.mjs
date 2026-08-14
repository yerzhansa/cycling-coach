import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWindowsPackage } from "./verify-windows-package.mjs";
import {
  WINDOWS_PACKAGE_APP_ID,
  WINDOWS_PACKAGE_GUID,
  WINDOWS_PACKAGE_PRODUCT_NAME,
  createWindowsPackagePlan,
} from "./windows-package-plan.mjs";

export const WINDOWS_INSTALLED_LIMITS = Object.freeze({
  installProcessMs: 120_000,
  filesystemMs: 30_000,
  commandMs: 120_000,
  listenerMs: 500,
  cleanupGraceMs: 5_000,
});

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalDesktopRoot = resolve(scriptDirectory, "..");
const packagedSelfTest = join(scriptDirectory, "verify-windows-packaged-self-test.mjs");
const nativeEvidenceScript = join(scriptDirectory, "windows-installed-evidence.ps1");

function checked(condition, message) {
  if (!condition) throw new Error(message);
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containedPath(root, candidate) {
  const remainder = win32.relative(root, candidate);
  return (
    remainder === "" ||
    (remainder !== ".." && !remainder.startsWith(`..${win32.sep}`) && !win32.isAbsolute(remainder))
  );
}

async function streamSha256(path, dependencies = {}) {
  const open = dependencies.createReadStream ?? createReadStream;
  const hash = createHash("sha256");
  for await (const chunk of open(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function collectCanonicalTree(root, dependencies = {}) {
  const absolute = dependencies.isAbsolute ?? isAbsolute;
  checked(absolute(root), "manifest root must be absolute");
  const inspect = dependencies.lstat ?? lstat;
  const list = dependencies.readdir ?? readdir;
  const rootStat = await inspect(root);
  checked(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    "manifest root must be a regular directory",
  );
  const entries = [];
  const folded = new Map();
  async function visit(directory, segments) {
    const names = (await list(directory)).sort(ordinalCompare);
    for (const name of names) {
      const childSegments = [...segments, name];
      const manifestPath = childSegments.join("/");
      const foldedPath = manifestPath.toLowerCase();
      checked(!folded.has(foldedPath), `manifest case-fold collision: ${manifestPath}`);
      folded.set(foldedPath, manifestPath);
      const absolutePath = join(directory, name);
      const metadata = await inspect(absolutePath);
      checked(
        !metadata.isSymbolicLink(),
        `manifest reparse point: ${manifestPath}`,
      );
      if (metadata.isDirectory()) {
        entries.push(Object.freeze({ path: manifestPath, type: "directory", size: 0, sha256: null }));
        await visit(absolutePath, childSegments);
      } else if (metadata.isFile()) {
        entries.push(
          Object.freeze({
            path: manifestPath,
            type: "file",
            size: metadata.size,
            sha256: await streamSha256(absolutePath, dependencies),
          }),
        );
      } else {
        throw new Error(`manifest entry is not a regular file or directory: ${manifestPath}`);
      }
    }
  }
  await visit(root, []);
  return Object.freeze(entries.sort((left, right) => ordinalCompare(left.path, right.path)));
}

function entryMap(entries, label) {
  const result = new Map();
  const folded = new Set();
  for (const entry of entries) {
    checked(
      entry !== null &&
        typeof entry === "object" &&
        typeof entry.path === "string" &&
        !entry.path.includes("\\") &&
        entry.path !== "" &&
        !entry.path.startsWith("/") &&
        !entry.path.split("/").includes(".."),
      `${label} manifest path is invalid`,
    );
    const key = entry.path.toLowerCase();
    checked(!folded.has(key), `${label} manifest case-fold collision: ${entry.path}`);
    folded.add(key);
    checked(!result.has(entry.path), `${label} manifest duplicate: ${entry.path}`);
    result.set(key, entry);
  }
  return result;
}

function assertSameEntry(expected, actual, path) {
  checked(actual.type === expected.type, `installed package type differs: ${path}`);
  checked(actual.size === expected.size, `installed package size differs: ${path}`);
  checked(actual.sha256 === expected.sha256, `installed package hash differs: ${path}`);
}

export function compareInstalledTree(retainedEntries, installedEntries, uninstallerRelativePath) {
  checked(
    typeof uninstallerRelativePath === "string" &&
      uninstallerRelativePath !== "" &&
      !uninstallerRelativePath.includes("\\") &&
      !uninstallerRelativePath.startsWith("/"),
    "uninstaller manifest path is invalid",
  );
  const retained = entryMap(retainedEntries, "retained");
  const installed = entryMap(installedEntries, "installed");
  const uninstallerKey = uninstallerRelativePath.toLowerCase();
  checked(!retained.has(uninstallerKey), "uninstaller unexpectedly exists in retained tree");
  for (const [key, expected] of retained) {
    const actual = installed.get(key);
    checked(actual !== undefined, `installed package entry is missing: ${expected.path}`);
    assertSameEntry(expected, actual, expected.path);
  }
  const extras = [...installed.entries()].filter(([key]) => !retained.has(key));
  checked(
    extras.length === 1 && extras[0][0] === uninstallerKey,
    `installed package has unexpected entries: ${extras.map(([, entry]) => entry.path).join(", ")}`,
  );
  const uninstaller = installed.get(uninstallerKey);
  checked(uninstaller?.type === "file", "installed uninstaller is not a regular file");
  checked(uninstaller.size > 0 && typeof uninstaller.sha256 === "string", "installed uninstaller is invalid");
  return Object.freeze({ uninstaller: Object.freeze({ ...uninstaller }) });
}

function parseUninstallValue(command, suffix, label) {
  checked(typeof command === "string", `registered ${label} command is malformed`);
  const match = /^"([^"]+\.exe)"(.*)$/u.exec(command);
  checked(match !== null && match[2] === suffix, `registered ${label} command is malformed`);
  return win32.normalize(match[1]);
}

export function parseRegisteredUninstallCommands(registration, installRoot) {
  const uninstaller = parseUninstallValue(
    registration.uninstallString,
    " /currentuser",
    "uninstall",
  );
  const quietUninstaller = parseUninstallValue(
    registration.quietUninstallString,
    " /currentuser /S",
    "quiet uninstall",
  );
  checked(win32.isAbsolute(uninstaller), "registered uninstaller path is not absolute");
  checked(
    containedPath(installRoot, uninstaller) &&
      uninstaller.toLowerCase() !== installRoot.toLowerCase(),
    "registered uninstaller is outside install root",
  );
  checked(
    quietUninstaller.toLowerCase() === uninstaller.toLowerCase(),
    "registered uninstall commands use different executables",
  );
  return Object.freeze({
    uninstaller,
    uninstallArgs: Object.freeze(["/currentuser"]),
    quietArgs: Object.freeze(["/currentuser", "/S"]),
  });
}

function exactRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function discoverInstalledPackage(evidence, expected) {
  checked(exactRecord(evidence), "installed evidence is malformed");
  checked(Array.isArray(evidence.registrations), "uninstall registration evidence is malformed");
  checked(
    evidence.registrations.length === 1,
    `expected one uninstall registration, found ${evidence.registrations.length}`,
  );
  const matches = evidence.registrations.filter(
    (entry) =>
      exactRecord(entry) &&
      entry.keyName === expected.guid &&
      entry.displayName === `${expected.productName} ${expected.version}` &&
      entry.displayVersion === expected.version,
  );
  checked(matches.length === 1, `expected one uninstall registration, found ${matches.length}`);
  const registration = matches[0];
  checked(
    typeof registration.keyPath === "string" &&
      typeof registration.installLocation === "string" &&
      typeof registration.uninstallString === "string",
    "uninstall registration is malformed",
  );
  const installRoot = win32.normalize(registration.installLocation);
  const programsRoot = win32.join(expected.localAppData, "Programs");
  const installRemainder = win32.relative(programsRoot, installRoot);
  checked(win32.isAbsolute(installRoot), "registered install root is not absolute");
  checked(
    installRemainder !== "" && containedPath(programsRoot, installRoot),
    "registered install root is outside LOCALAPPDATA Programs",
  );
  const executable = win32.join(installRoot, `${expected.productName}.exe`);
  const commands = parseRegisteredUninstallCommands(registration, installRoot);
  return Object.freeze({ registration, installRoot, executable, ...commands });
}

export function validateSignaturePolicy(evidence, policy, ownedPaths, expectedPaths = []) {
  checked(policy === "unsigned-private", "unsupported Windows signature policy");
  checked(Array.isArray(evidence), "signature evidence is malformed");
  const owned = new Set(ownedPaths.map((path) => win32.normalize(path).toLowerCase()));
  const expected = new Set(expectedPaths.map((path) => win32.normalize(path).toLowerCase()));
  const seen = new Set();
  for (const signature of evidence) {
    checked(
      exactRecord(signature) &&
        typeof signature.path === "string" &&
        typeof signature.status === "string",
      "signature evidence is malformed",
    );
    const path = win32.normalize(signature.path).toLowerCase();
    checked(expected.has(path), `unexpected signature evidence: ${signature.path}`);
    checked(!seen.has(path), `duplicate signature evidence: ${signature.path}`);
    seen.add(path);
    if (owned.has(path)) {
      checked(signature.status === "NotSigned", `Enduragent-owned binary signature is ${signature.status}`);
    } else {
      checked(
        signature.status === "Valid" || signature.status === "NotSigned",
        `retained vendor binary signature is ${signature.status}`,
      );
    }
  }
  for (const path of owned) checked(seen.has(path), `signature evidence is missing: ${path}`);
  for (const path of expected) {
    checked(
      seen.has(path),
      `signature evidence is missing: ${path}`,
    );
  }
  return true;
}

function parseDriverArguments(args) {
  const result = { githubHosted: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--github-hosted") {
      checked(result.githubHosted === false, "duplicate --github-hosted");
      result.githubHosted = true;
      continue;
    }
    if (["--signature-policy", "--installer", "--application"].includes(argument)) {
      const value = args[index + 1];
      checked(typeof value === "string" && !value.startsWith("--"), `${argument} requires a value`);
      const key = {
        "--signature-policy": "signaturePolicy",
        "--installer": "installer",
        "--application": "application",
      }[argument];
      checked(result[key] === undefined, `duplicate ${argument}`);
      result[key] = value;
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${argument}`);
  }
  checked(result.githubHosted === true, "--github-hosted is required");
  checked(result.signaturePolicy === "unsigned-private", "--signature-policy unsigned-private is required");
  if (result.installer !== undefined) checked(isAbsolute(result.installer), "installer path must be absolute");
  if (result.application !== undefined) checked(isAbsolute(result.application), "application path must be absolute");
  return result;
}

function capture(file, args, timeoutMs, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(file, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`${basename(file)} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, stdout, stderr });
    });
  });
}

function requireSuccessful(result, label) {
  checked(
    result.code === 0 && result.signal === null,
    `${label} failed${result.stderr === "" ? "" : `: ${result.stderr.trim()}`}`,
  );
  return result;
}

const nativeFailureStages = new Set([
  "request",
  "install-location",
  "evidence",
  "seed-startup",
  "terminate-installed",
  "registrations",
  "program-residues",
  "processes",
  "shortcut",
  "run",
  "startup-approved",
  "reparse-paths",
  "signatures",
  "internal",
]);

export function parseNativeEvidenceResult(result, label) {
  checked(result.stderr === "", `${label} wrote stderr`);
  const lines = result.stdout.split(/\r?\n/u).filter((line) => line !== "");
  checked(lines.length === 1, `${label} did not emit exactly one JSON result`);
  let value;
  try {
    value = JSON.parse(lines[0]);
  } catch {
    throw new Error(`${label} emitted malformed JSON`);
  }
  if (result.code === 0 && result.signal === null) {
    checked(value?.ok === true, `${label} reported failure`);
    return value;
  }
  checked(
    result.signal === null &&
      exactRecord(value) &&
      Object.keys(value).sort().join(",") === "error,ok" &&
      value.ok === false &&
      exactRecord(value.error) &&
      Object.keys(value.error).sort().join(",") === "code,stage" &&
      value.error.code === "NATIVE_EVIDENCE_FAILED" &&
      nativeFailureStages.has(value.error.stage),
    `${label} failed`,
  );
  throw new Error(`${label} failed at ${value.error.stage}`);
}

async function runNativeEvidence(request, scratch, dependencies = {}) {
  const requestPath = join(scratch, `native-${randomUUID()}.json`);
  await (dependencies.writeFile ?? writeFile)(requestPath, JSON.stringify(request), { mode: 0o600 });
  const run = dependencies.capture ?? capture;
  const result = await run(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      nativeEvidenceScript,
      "-RequestPath",
      requestPath,
    ],
    WINDOWS_INSTALLED_LIMITS.commandMs,
  );
  return parseNativeEvidenceResult(result, `native Windows evidence ${request.action}`);
}

function commonNativeRequest(expected, roots) {
  return {
    productName: expected.productName,
    appId: WINDOWS_PACKAGE_APP_ID,
    guid: WINDOWS_PACKAGE_GUID,
    version: expected.version,
    localAppData: roots.localAppData,
    appData: roots.appData,
    userProfile: roots.userProfile,
    cleanupGraceMs: WINDOWS_INSTALLED_LIMITS.cleanupGraceMs,
    programsRoot: win32.join(roots.localAppData, "Programs"),
    shortcutPath: win32.join(
      roots.appData,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      `${expected.productName}.lnk`,
    ),
  };
}

function validateHostedEnvironment(environment, platform, arch) {
  checked(platform === "win32", "installed Windows package test requires Windows");
  checked(arch === "x64", "installed Windows package test requires x64 Node");
  checked(environment.GITHUB_ACTIONS === "true", "GITHUB_ACTIONS=true is required");
  checked(environment.RUNNER_ENVIRONMENT === "github-hosted", "RUNNER_ENVIRONMENT=github-hosted is required");
  const roots = {
    userProfile: environment.USERPROFILE,
    localAppData: environment.LOCALAPPDATA,
    appData: environment.APPDATA,
  };
  for (const [name, path] of Object.entries(roots)) {
    checked(typeof path === "string" && win32.isAbsolute(path), `${name} must be an absolute path`);
  }
  return roots;
}

function assertCleanPreflight(evidence) {
  checked(Array.isArray(evidence.registrations) && evidence.registrations.length === 0, "pre-existing app registration");
  checked(Array.isArray(evidence.programResidues) && evidence.programResidues.length === 0, "pre-existing app install");
  checked(Array.isArray(evidence.processes) && evidence.processes.length === 0, "pre-existing app process");
  checked(evidence.shortcut?.exists === false, "pre-existing app shortcut");
  checked(evidence.run?.exists === false, "pre-existing app Run registration");
  checked(evidence.startupApproved?.exists === false, "pre-existing app StartupApproved registration");
}

async function assertSafeInstallRoot(programsRoot, installRoot, dependencies = {}) {
  const canonicalize = dependencies.realpath ?? realpath;
  const inspect = dependencies.lstat ?? lstat;
  const programsMetadata = await inspect(programsRoot);
  checked(
    programsMetadata.isDirectory() && !programsMetadata.isSymbolicLink(),
    "Programs root is a reparse point",
  );
  const canonicalPrograms = await canonicalize(programsRoot);
  const canonicalInstall = await canonicalize(installRoot);
  const canonicalRemainder = win32.relative(canonicalPrograms, canonicalInstall);
  checked(
    canonicalRemainder !== "" && containedPath(canonicalPrograms, canonicalInstall),
    "real install root is outside Programs",
  );
  const remainder = win32.relative(programsRoot, installRoot);
  let current = programsRoot;
  for (const segment of remainder.split(win32.sep)) {
    current = win32.join(current, segment);
    const metadata = await inspect(current);
    checked(metadata.isDirectory() && !metadata.isSymbolicLink(), `install ancestor is a reparse point: ${current}`);
  }
}

function assertNoReparsePoints(evidence) {
  checked(Array.isArray(evidence.reparsePaths), "reparse evidence is malformed");
  checked(evidence.reparsePaths.length === 0, `package contains reparse points: ${evidence.reparsePaths.join(", ")}`);
}

function signatureInventory(installedEntries, installRoot) {
  return installedEntries
    .filter(
      (entry) =>
        entry.type === "file" && [".exe", ".dll"].includes(win32.extname(entry.path).toLowerCase()),
    )
    .map((entry) => win32.join(installRoot, ...entry.path.split("/")));
}

async function waitForPathState(path, expected, dependencies = {}) {
  const inspect = dependencies.lstat ?? lstat;
  const delay = dependencies.delay ?? ((milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)));
  const deadline = performance.now() + WINDOWS_INSTALLED_LIMITS.filesystemMs;
  while (performance.now() < deadline) {
    let exists = true;
    try {
      await inspect(path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      exists = false;
    }
    if (exists === expected) return;
    await delay(WINDOWS_INSTALLED_LIMITS.listenerMs);
  }
  throw new Error(`filesystem state timed out: ${path}`);
}

export async function executeWithGuaranteedUninstall(primary, uninstall) {
  let primaryError;
  let cleanupError;
  try {
    await primary();
  } catch (error) {
    primaryError = error;
  }
  try {
    await uninstall();
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([primaryError, cleanupError], "installed package test and uninstall both failed");
  }
  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function seedDurableRoots(roots) {
  const token = randomUUID();
  const sentinels = [
    { root: win32.join(roots.userProfile, ".enduragent"), name: `.w17-${token}.sentinel` },
    { root: win32.join(roots.localAppData, "Enduragent"), name: `.w17-${token}.sentinel` },
  ];
  for (const sentinel of sentinels) {
    await mkdir(sentinel.root, { recursive: true });
    sentinel.path = win32.join(sentinel.root, sentinel.name);
    sentinel.bytes = Buffer.from(`enduragent-w17-${token}\n`, "utf8");
    await writeFile(sentinel.path, sentinel.bytes, { flag: "wx", mode: 0o600 });
    sentinel.manifest = await collectCanonicalTree(sentinel.root);
  }
  return sentinels;
}

async function verifyDurableRoots(sentinels) {
  for (const sentinel of sentinels) {
    const bytes = await readFile(sentinel.path);
    checked(bytes.equals(sentinel.bytes), `durable sentinel changed: ${sentinel.path}`);
    const manifest = await collectCanonicalTree(sentinel.root);
    checked(
      JSON.stringify(manifest) === JSON.stringify(sentinel.manifest),
      `durable root changed: ${sentinel.root}`,
    );
  }
}

function assertSeededStartup(evidence, expected) {
  checked(evidence.run?.exists === true && evidence.run.value === expected.runValue, "Run sentinel was not seeded exactly");
  checked(
    evidence.startupApproved?.exists === true &&
      evidence.startupApproved.valueBase64 === expected.startupApprovedValueBase64,
    "StartupApproved sentinel was not seeded exactly",
  );
}

function assertCleanupEvidence(evidence) {
  checked(
    Array.isArray(evidence.registrations) && evidence.registrations.length === 0,
    "uninstall registration remains",
  );
  checked(evidence.shortcut?.exists === false, "Start Menu shortcut remains");
  checked(
    Array.isArray(evidence.programResidues) && evidence.programResidues.length === 0,
    "installed program residue remains",
  );
  checked(evidence.run?.exists === false, "Run registration remains");
  checked(evidence.startupApproved?.exists === false, "StartupApproved registration remains");
  checked(Array.isArray(evidence.processes) && evidence.processes.length === 0, "installed process remains");
}

export async function runWindowsInstalledPackage(input = {}, dependencies = {}) {
  const args = input.args ?? process.argv.slice(2);
  const options = parseDriverArguments(args);
  const roots = validateHostedEnvironment(
    input.environment ?? process.env,
    input.platform ?? process.platform,
    input.arch ?? process.arch,
  );
  const desktopRoot = input.desktopRoot ?? canonicalDesktopRoot;
  const plan = await (dependencies.createWindowsPackagePlan ?? createWindowsPackagePlan)({ desktopRoot });
  const installer = options.installer === undefined ? plan.artifactPath : resolve(options.installer);
  const application = options.application === undefined ? plan.applicationPath : resolve(options.application);
  checked(basename(installer) === plan.artifactName, "installer does not match the frozen package plan");
  checked(application === plan.applicationPath, "retained win-unpacked does not match the frozen package plan");
  const scratchBase = await realpath(tmpdir());
  const scratch = await mkdtemp(join(scratchBase, "enduragent-w17-"));
  const expected = {
    productName: WINDOWS_PACKAGE_PRODUCT_NAME,
    version: plan.version,
    localAppData: roots.localAppData,
    guid: WINDOWS_PACKAGE_GUID,
  };
  const common = commonNativeRequest(expected, roots);
  const runNative = dependencies.runNativeEvidence ?? runNativeEvidence;
  const run = dependencies.capture ?? capture;
  let installAttempted = false;
  let installRootValidated = false;
  let installed;
  let sentinels;
  let installerDigest;
  let uninstallerDigest;
  try {
    const preflight = await runNative({ ...common, action: "evidence", treeRoots: [], signaturePaths: [] }, scratch, dependencies);
    assertCleanPreflight(preflight);
    const packageEvidence = await (dependencies.verifyWindowsPackage ?? verifyWindowsPackage)(
      installer,
      application,
      { desktopRoot },
    );
    const retainedManifest = await collectCanonicalTree(application, dependencies);
    installerDigest = await streamSha256(installer, dependencies);
    checked(
      installerDigest === packageEvidence.artifact.sha256,
      "installer changed after package verification",
    );
    await executeWithGuaranteedUninstall(
      async () => {
        installAttempted = true;
        requireSuccessful(
          await run(installer, ["/S"], WINDOWS_INSTALLED_LIMITS.installProcessMs),
          "silent NSIS install",
        );
        const discoveredEvidence = await runNative(
          { ...common, action: "evidence", treeRoots: [application], signaturePaths: [] },
          scratch,
          dependencies,
        );
        installed = discoverInstalledPackage(discoveredEvidence, expected);
        checked(
          discoveredEvidence.shortcut?.exists === true &&
            typeof discoveredEvidence.shortcut.path === "string" &&
            typeof discoveredEvidence.shortcut.targetPath === "string" &&
            win32.normalize(discoveredEvidence.shortcut.path) ===
              win32.normalize(common.shortcutPath) &&
            win32.normalize(discoveredEvidence.shortcut.targetPath).toLowerCase() ===
              installed.executable.toLowerCase() &&
            discoveredEvidence.shortcut.arguments === "",
          "installed Start Menu shortcut is missing or malformed",
        );
        await assertSafeInstallRoot(common.programsRoot, installed.installRoot, dependencies);
        installRootValidated = true;
        await waitForPathState(installed.executable, true, dependencies);
        await waitForPathState(installed.uninstaller, true, dependencies);
        const installedManifest = await collectCanonicalTree(installed.installRoot, dependencies);
        const uninstallerRelativePath = relative(installed.installRoot, installed.uninstaller)
          .split(win32.sep)
          .join("/");
        const comparison = compareInstalledTree(
          retainedManifest,
          installedManifest,
          uninstallerRelativePath,
        );
        uninstallerDigest = comparison.uninstaller.sha256;
        const signatures = signatureInventory(installedManifest, installed.installRoot);
        signatures.push(installer);
        const signedEvidence = await runNative(
          {
            ...common,
            action: "evidence",
            installRoot: installed.installRoot,
            treeRoots: [application, installed.installRoot],
            signaturePaths: signatures,
          },
          scratch,
          dependencies,
        );
        assertNoReparsePoints(signedEvidence);
        validateSignaturePolicy(
          signedEvidence.signatures,
          options.signaturePolicy,
          [installer, installed.executable, installed.uninstaller],
          signatures,
        );
        sentinels = await seedDurableRoots(roots);
        const startup = {
          runValue: `"${installed.executable}" --w17-sentinel`,
          startupApprovedValueBase64: Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString(
            "base64",
          ),
        };
        const seeded = await runNative(
          { ...common, ...startup, action: "seed-startup", installRoot: installed.installRoot },
          scratch,
          dependencies,
        );
        assertSeededStartup(seeded, startup);
        requireSuccessful(
          await run(
            process.execPath,
            [packagedSelfTest, "--executable", installed.executable],
            WINDOWS_INSTALLED_LIMITS.commandMs,
            { cwd: desktopRoot },
          ),
          "installed packaged self-test",
        );
      },
      async () => {
        if (!installAttempted) return;
        if (installed === undefined) {
          const evidence = await runNative(
            { ...common, action: "evidence", treeRoots: [], signaturePaths: [] },
            scratch,
            dependencies,
          );
          if (evidence.registrations.length === 0 && evidence.programResidues.length === 0) return;
          installed = discoverInstalledPackage(evidence, expected);
        }
        if (!installRootValidated) {
          await assertSafeInstallRoot(common.programsRoot, installed.installRoot, dependencies);
          installRootValidated = true;
        }
        const failures = [];
        async function attempt(operation) {
          try {
            await operation();
          } catch (error) {
            failures.push(error);
          }
        }
        await attempt(() =>
          runNative(
            { ...common, action: "terminate-installed", installRoot: installed.installRoot },
            scratch,
            dependencies,
          ),
        );
        await attempt(async () =>
          requireSuccessful(
            await run(
              installed.uninstaller,
              installed.quietArgs,
              WINDOWS_INSTALLED_LIMITS.installProcessMs,
            ),
            "silent NSIS uninstall",
          ),
        );
        await attempt(() => waitForPathState(installed.installRoot, false, dependencies));
        await attempt(async () => {
          const cleanup = await runNative(
            {
              ...common,
              action: "evidence",
              installRoot: installed.installRoot,
              treeRoots: [],
              signaturePaths: [],
            },
            scratch,
            dependencies,
          );
          assertCleanupEvidence(cleanup);
        });
        if (sentinels !== undefined) await attempt(() => verifyDurableRoots(sentinels));
        await attempt(async () => {
          const finalInstallerDigest = await streamSha256(installer, dependencies);
          checked(finalInstallerDigest === installerDigest, "installer changed during installed test");
        });
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "installed package cleanup failed");
      },
    );
    return Object.freeze({
      installer,
      application,
      installRoot: installed.installRoot,
      installerSha256: installerDigest,
      uninstallerSha256: uninstallerDigest,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function main() {
  try {
    const result = await runWindowsInstalledPackage();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const errors = error instanceof AggregateError ? error.errors : [error];
    process.stderr.write(`${errors.map((entry) => entry instanceof Error ? entry.message : String(entry)).join("; ")}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
