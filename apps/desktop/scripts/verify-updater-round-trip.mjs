import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "@enduragent/coach-contract";
import {
  DESKTOP_UPDATER_CACHE_DIRECTORY,
  requireGenericFeedUrl,
  requireStableSemVer,
} from "./macos-release-plan.mjs";
import {
  inspectMacosReleaseApplication,
  verifyMacosReleaseArtifacts,
} from "./verify-macos-release.mjs";
import { connectCdp, reservePort, waitForPage } from "../tests/helpers/desktop-fixture.ts";
import {
  callAcceptanceCdp,
  runAcceptanceCommand,
  withAcceptanceDeadline,
} from "../tests/fixtures/packaged-telegram/acceptance-deadline.ts";
import {
  observeTelegramAcceptanceChild,
  telegramAcceptanceDebuggerListenerOwner,
} from "../tests/fixtures/packaged-telegram/process-safety.ts";

export const MACOS_UPDATER_ROUND_TRIP_MODE = "steady";
export const MACOS_UPDATER_ROUND_TRIP_FEED_URL =
  "https://github.com/yerzhansa/enduragent/releases/latest/download/";

const productName = "Enduragent";
const maximumUpdateInfoBytes = 16_384;
const downloadTimeoutMs = 10 * 60_000;
const transitionTimeoutMs = 2 * 60_000;
const shutdownTimeoutMs = 30_000;
const credentialDirectoryName = "credentials-v1";
const persistenceCredentialSlot = "openrouter";
const persistenceChatId = "desktop";
const maximumPersistenceFiles = 20_000;

class MacosUpdaterRoundTripError extends Error {
  constructor(message) {
    super(message);
    this.name = "MacosUpdaterRoundTripError";
  }
}

function fail(message) {
  throw new MacosUpdaterRoundTripError(message);
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!exactObject(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function olderStableSemVer(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (const [index, part] of leftParts.entries()) {
    if (part < rightParts[index]) return true;
    if (part > rightParts[index]) return false;
  }
  return false;
}

function requireAbsoluteDistinctPaths(paths) {
  const values = Object.values(paths);
  if (values.some((path) => typeof path !== "string" || !isAbsolute(path))) {
    fail("round-trip paths must be absolute");
  }
  const resolved = values.map((path) => resolve(path));
  if (new Set(resolved).size !== resolved.length) {
    fail("round-trip paths must be distinct");
  }
  for (const [index, path] of resolved.entries()) {
    for (const [otherIndex, otherPath] of resolved.entries()) {
      if (index === otherIndex) continue;
      const relation = relative(path, otherPath);
      if (
        relation !== "" &&
        relation !== ".." &&
        !relation.startsWith(`..${sep}`) &&
        !isAbsolute(relation)
      ) {
        fail("round-trip paths must not contain one another");
      }
    }
  }
}

export function requireMacosUpdaterRoundTripInput(input, context = {}) {
  if (!exactObject(input)) fail("round-trip input is invalid");
  const platform = context.platform ?? process.platform;
  const arch = context.arch ?? process.arch;
  const mode = context.mode ?? process.env.ENDURAGENT_MACOS_UPDATE_ROUNDTRIP_MODE;
  if (platform !== "darwin" || arch !== "arm64" || mode !== MACOS_UPDATER_ROUND_TRIP_MODE) {
    fail("round-trip requires a steady macOS arm64 runner");
  }
  let baselineVersion;
  let candidateVersion;
  try {
    baselineVersion = requireStableSemVer(input.baselineVersion);
    candidateVersion = requireStableSemVer(input.candidateVersion);
  } catch {
    fail("round-trip versions are invalid");
  }
  if (!olderStableSemVer(baselineVersion, candidateVersion)) {
    fail("round-trip candidate must be newer than baseline");
  }
  const paths = {
    baselineEnvelope: input.baselineEnvelope,
    candidateEnvelope: input.candidateEnvelope,
    evidencePath: input.evidencePath,
  };
  requireAbsoluteDistinctPaths(paths);
  if (basename(paths.evidencePath).length === 0 || !paths.evidencePath.endsWith(".json")) {
    fail("round-trip evidence path is invalid");
  }
  return Object.freeze({ baselineVersion, candidateVersion, ...paths });
}

function requireInspectorIdentity(value, label) {
  const keys = [
    "version",
    "enduragentDesktopRelease",
    "feedUrl",
    "bundleIdentifier",
    "teamIdentifier",
    "designatedRequirementSha256",
    "codeDirectorySha256",
    "cdHash",
  ];
  if (
    !exactKeys(value, keys) ||
    value.enduragentDesktopRelease !== true ||
    typeof value.version !== "string" ||
    typeof value.feedUrl !== "string" ||
    typeof value.bundleIdentifier !== "string" ||
    typeof value.teamIdentifier !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.designatedRequirementSha256) ||
    !/^[0-9a-f]{64}$/u.test(value.codeDirectorySha256) ||
    !/^[0-9a-f]{40}$/u.test(value.cdHash) ||
    value.cdHash !== value.codeDirectorySha256.slice(0, 40)
  ) {
    fail(`${label} release identity is invalid`);
  }
  return value;
}

function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

export function verifyMacosUpdaterRoundTripIdentities(input) {
  if (!exactObject(input)) fail("round-trip identities are invalid");
  const baseline = requireInspectorIdentity(input.baseline, "baseline");
  const candidate = requireInspectorIdentity(input.candidate, "candidate");
  const installedBaseline = requireInspectorIdentity(input.installedBaseline, "installed baseline");
  const relaunched = requireInspectorIdentity(input.relaunched, "relaunched");
  let expectedFeed;
  try {
    expectedFeed = requireGenericFeedUrl(input.expectedFeedUrl);
  } catch {
    fail("round-trip feed URL is invalid");
  }
  if (
    baseline.version !== input.baselineVersion ||
    candidate.version !== input.candidateVersion ||
    !sameIdentity(baseline, installedBaseline) ||
    !sameIdentity(candidate, relaunched) ||
    baseline.feedUrl !== expectedFeed ||
    candidate.feedUrl !== expectedFeed ||
    baseline.bundleIdentifier !== candidate.bundleIdentifier ||
    baseline.teamIdentifier !== candidate.teamIdentifier ||
    baseline.designatedRequirementSha256 !== candidate.designatedRequirementSha256 ||
    baseline.codeDirectorySha256 === candidate.codeDirectorySha256
  ) {
    fail("round-trip release identity continuity failed");
  }
  return Object.freeze({
    bundleIdentifier: candidate.bundleIdentifier,
    teamIdentifier: candidate.teamIdentifier,
    designatedRequirementSha256: candidate.designatedRequirementSha256,
    baselineCodeDirectorySha256: baseline.codeDirectorySha256,
    candidateCodeDirectorySha256: candidate.codeDirectorySha256,
    candidateCdHash: candidate.cdHash,
  });
}

export function parseMacosDownloadedUpdateInfo(value, expected) {
  if (
    !exactKeys(value, ["fileName", "sha512", "isAdminRightsRequired"]) ||
    value.fileName !== expected.fileName ||
    value.sha512 !== expected.sha512 ||
    value.isAdminRightsRequired !== false
  ) {
    fail("downloaded update metadata does not match the candidate");
  }
  return Object.freeze({
    fileName: value.fileName,
    sha512: value.sha512,
    isAdminRightsRequired: false,
  });
}

function normalizedLsofPath(path) {
  return path.endsWith(" (deleted)") ? path.slice(0, -10) : path;
}

export function parseMacosApplicationProcessObservation(bytes, application) {
  if (!(bytes instanceof Uint8Array) || !isAbsolute(application) || !application.endsWith(".app")) {
    fail("application process observation is invalid");
  }
  const executable = join(application, `Contents/MacOS/${productName}`);
  const pathsByPid = new Map();
  let currentPid;
  let textDescriptor = false;
  for (const raw of Buffer.from(bytes).toString("utf8").split("\0")) {
    const field = raw.replace(/^[\r\n]+|[\r\n]+$/gu, "");
    if (field === "") continue;
    const processMatch = /^p(\d+)$/u.exec(field);
    if (processMatch !== null) {
      currentPid = Number(processMatch[1]);
      if (!Number.isSafeInteger(currentPid) || currentPid < 1 || pathsByPid.has(currentPid)) {
        fail("application process observation is ambiguous");
      }
      pathsByPid.set(currentPid, new Set());
      textDescriptor = false;
      continue;
    }
    if (field === "ftxt" && currentPid !== undefined) {
      textDescriptor = true;
      continue;
    }
    if (field.startsWith("f") && currentPid !== undefined) {
      textDescriptor = false;
      continue;
    }
    if (field.startsWith("n") && currentPid !== undefined && textDescriptor) {
      const path = normalizedLsofPath(field.slice(1));
      if (path !== application && !path.startsWith(`${application}/`)) {
        fail("application process observation escaped the bundle");
      }
      pathsByPid.get(currentPid).add(path);
      textDescriptor = false;
      continue;
    }
    fail("application process observation is malformed");
  }
  const bundlePids = [...pathsByPid.entries()]
    .filter(([, paths]) => paths.size > 0)
    .map(([pid]) => pid)
    .sort((left, right) => left - right);
  const mainPids = [...pathsByPid.entries()]
    .filter(([, paths]) => paths.has(executable))
    .map(([pid]) => pid)
    .sort((left, right) => left - right);
  return Object.freeze({
    bundlePids: Object.freeze(bundlePids),
    mainPids: Object.freeze(mainPids),
  });
}

function fileIdentity(stat) {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  });
}

function sameFileIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

async function digestStableFile(path, label) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    !Number.isSafeInteger(before.size) ||
    before.size <= 0
  ) {
    fail(`${label} is invalid`);
  }
  const sha256 = createHash("sha256");
  const sha512 = createHash("sha512");
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      size += chunk.length;
      sha256.update(chunk);
      sha512.update(chunk);
    }
  } catch {
    fail(`${label} is unreadable`);
  }
  let after;
  try {
    after = await lstat(path);
  } catch {
    fail(`${label} changed while reading`);
  }
  const identity = fileIdentity(before);
  if (
    size !== before.size ||
    after.isSymbolicLink() ||
    !after.isFile() ||
    !sameFileIdentity(identity, fileIdentity(after))
  ) {
    fail(`${label} changed while reading`);
  }
  return Object.freeze({
    identity,
    size,
    sha256: sha256.digest("hex"),
    sha512: sha512.digest("base64"),
  });
}

async function readStableJson(path, label) {
  let before;
  try {
    before = await lstat(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.size <= 0 ||
    before.size > maximumUpdateInfoBytes
  ) {
    fail(`${label} is invalid`);
  }
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    fail(`${label} is unreadable`);
  }
  let after;
  try {
    after = await lstat(path);
  } catch {
    fail(`${label} changed while reading`);
  }
  if (
    bytes.length !== before.size ||
    !sameFileIdentity(fileIdentity(before), fileIdentity(after))
  ) {
    fail(`${label} changed while reading`);
  }
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is invalid JSON`);
  }
}

async function compareStableFiles(leftPath, leftDigest, rightPath, rightDigest) {
  const [leftBefore, rightBefore] = await Promise.all([lstat(leftPath), lstat(rightPath)]);
  if (
    !sameFileIdentity(leftDigest.identity, fileIdentity(leftBefore)) ||
    !sameFileIdentity(rightDigest.identity, fileIdentity(rightBefore))
  ) {
    fail("candidate ZIP changed before byte comparison");
  }
  const compared = await runAcceptanceCommand("/usr/bin/cmp", ["-s", leftPath, rightPath], {
    allowFailure: true,
    timeoutMs: 2 * 60_000,
  });
  const [leftAfter, rightAfter] = await Promise.all([lstat(leftPath), lstat(rightPath)]);
  if (
    compared.code !== 0 ||
    compared.signal !== null ||
    compared.stdout.length !== 0 ||
    compared.stderr.length !== 0 ||
    !sameFileIdentity(leftDigest.identity, fileIdentity(leftAfter)) ||
    !sameFileIdentity(rightDigest.identity, fileIdentity(rightAfter))
  ) {
    fail("downloaded ZIP differs from the sealed candidate");
  }
}

async function requireDirectory(path, label) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label} is invalid`);
  return stat;
}

async function extractSingleApplication(zipPath, destination) {
  await mkdir(destination, { mode: 0o700 });
  try {
    await runAcceptanceCommand("/usr/bin/ditto", ["-x", "-k", "--rsrc", zipPath, destination], {
      timeoutMs: 2 * 60_000,
    });
  } catch {
    fail("release ZIP extraction failed");
  }
  const entries = await readdir(destination);
  if (entries.length !== 1 || entries[0] !== `${productName}.app`) {
    fail("release ZIP must contain exactly one root application");
  }
  const application = join(destination, entries[0]);
  await requireDirectory(application, "extracted release application");
  return application;
}

async function installApplication(source, destination) {
  await requireDirectory(source, "baseline release application");
  try {
    await runAcceptanceCommand(
      "/usr/bin/ditto",
      ["--rsrc", "--extattr", "--qtn", "--acl", source, destination],
      { timeoutMs: 2 * 60_000 },
    );
  } catch {
    fail("baseline application installation failed");
  }
  await requireDirectory(destination, "installed baseline application");
}

async function requireMissing(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    fail(`${label} is inaccessible`);
  }
  fail(`${label} must be empty before the round trip`);
}

async function observeApplicationProcesses(application) {
  const result = await runAcceptanceCommand(
    "/usr/sbin/lsof",
    ["-n", "-P", "-a", "-d", "txt", "+D", application, "-F0pfn"],
    { allowFailure: true },
  );
  if (
    result.code === 1 &&
    result.signal === null &&
    result.stdout.length === 0 &&
    result.stderr.length === 0
  ) {
    return Object.freeze({ bundlePids: Object.freeze([]), mainPids: Object.freeze([]) });
  }
  if (result.code !== 0 || result.signal !== null || result.stderr.length !== 0) {
    fail("application process observation failed");
  }
  return parseMacosApplicationProcessObservation(result.stdout, application);
}

async function debuggerListenerOwner(port, environment) {
  const result = await runAcceptanceCommand(
    "/usr/sbin/lsof",
    ["-n", "-P", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-F0p"],
    { allowFailure: true, environment },
  );
  return telegramAcceptanceDebuggerListenerOwner(result);
}

async function waitUntil(description, probe, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== false && value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  if (lastError instanceof MacosUpdaterRoundTripError) throw lastError;
  fail(`${description} timed out`);
}

async function evaluateRenderer(connection, expression) {
  const response = await callAcceptanceCdp(connection, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails !== undefined || !exactObject(response.result)) {
    fail("renderer evaluation failed");
  }
  return response.result.value;
}

async function callAuthBridge(connection, method, args = []) {
  const target = await callAcceptanceCdp(connection, "Runtime.evaluate", {
    expression: "window.enduragentAuth",
    returnByValue: false,
  });
  const objectId = target.result?.objectId;
  if (typeof objectId !== "string" || objectId.length === 0) {
    fail("desktop authentication bridge is unavailable");
  }
  try {
    const response = await callAcceptanceCdp(connection, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "async function(method, args) { return await this[method](...args); }",
      arguments: [{ value: method }, { value: args }],
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails !== undefined || !exactObject(response.result)) {
      fail("desktop authentication bridge call failed");
    }
    return response.result.value;
  } finally {
    await callAcceptanceCdp(connection, "Runtime.releaseObject", { objectId }).catch(() => {});
  }
}

async function callRendererRpc(connection, expectedAthleteHome, method, params) {
  const input = JSON.stringify({
    expectedAthleteHome,
    method,
    params,
    protocolVersion: PROTOCOL_VERSION,
  });
  const response = await evaluateRenderer(
    connection,
    `(async () => {
      const input = ${input};
      const binding = await window.enduragentAuth.getDaemonConnection();
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(binding.url);
        let accepted;
        const timer = setTimeout(() => {
          socket.close();
          reject(new Error("RPC timeout"));
        }, 10000);
        const finish = (callback, value) => {
          clearTimeout(timer);
          socket.close();
          callback(value);
        };
        socket.addEventListener("open", () => {
          socket.send(JSON.stringify({
            type: "handshake",
            token: binding.rendererCapability,
            clientProtocolVersion: input.protocolVersion,
          }));
        });
        socket.addEventListener("error", () => finish(reject, new Error("RPC transport failed")));
        socket.addEventListener("message", (event) => {
          let frame;
          try {
            frame = JSON.parse(event.data);
          } catch {
            finish(reject, new Error("RPC frame was invalid"));
            return;
          }
          if (accepted === undefined) {
            if (
              frame?.type !== "handshake" ||
              frame.status !== "accepted" ||
              frame.clientProtocolVersion !== input.protocolVersion ||
              frame.serverProtocolVersion !== input.protocolVersion ||
              frame.owner !== "app-supervised" ||
              frame.athleteHome !== input.expectedAthleteHome ||
              frame.rendererCapability !== binding.rendererCapability
            ) {
              finish(reject, new Error("RPC handshake was invalid"));
              return;
            }
            accepted = { owner: frame.owner, athleteHome: frame.athleteHome };
            socket.send(JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: input.method,
              params: input.params,
            }));
            return;
          }
          if (frame?.id !== 1) return;
          if (frame.jsonrpc !== "2.0" || frame.error !== undefined || !("result" in frame)) {
            finish(reject, new Error("RPC request failed"));
            return;
          }
          finish(resolve, { ...accepted, result: frame.result });
        });
      });
    })()`,
  );
  if (
    !exactObject(response) ||
    response.owner !== "app-supervised" ||
    response.athleteHome !== expectedAthleteHome ||
    !("result" in response)
  ) {
    fail("renderer RPC result is invalid");
  }
  return response;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (exactObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function configuredCredential(statuses) {
  if (!Array.isArray(statuses)) return false;
  const matches = statuses.filter((status) => status?.slot === persistenceCredentialSlot);
  return matches.length === 1 && matches[0].state === "configured";
}

function sameDigest(left, right) {
  return (
    exactKeys(left, ["sha256", "sha512", "size"]) &&
    exactKeys(right, ["sha256", "sha512", "size"]) &&
    left.size === right.size &&
    left.sha256 === right.sha256 &&
    left.sha512 === right.sha512
  );
}

export function verifyMacosUpdaterRoundTripPersistence(input) {
  const before = input?.before;
  const after = input?.after;
  if (
    !exactKeys(input, ["after", "before", "plaintextCredentialAbsent"]) ||
    input.plaintextCredentialAbsent !== true ||
    !exactKeys(before, [
      "athleteHome",
      "athleteState",
      "credentialCiphertext",
      "credentialStatuses",
      "memory",
      "owner",
      "runtimeConfig",
      "session",
      "unitsPreference",
    ]) ||
    !exactKeys(after, [
      "athleteHome",
      "athleteState",
      "credentialCiphertext",
      "credentialStatuses",
      "memory",
      "owner",
      "runtimeConfig",
      "session",
      "unitsPreference",
    ]) ||
    before.owner !== "app-supervised" ||
    after.owner !== "app-supervised" ||
    before.athleteHome !== after.athleteHome ||
    typeof before.athleteHome !== "string" ||
    before.athleteHome.length === 0 ||
    !configuredCredential(before.credentialStatuses) ||
    !configuredCredential(after.credentialStatuses) ||
    !sameDigest(before.credentialCiphertext, after.credentialCiphertext) ||
    !sameDigest(before.memory, after.memory) ||
    !sameDigest(before.session, after.session) ||
    canonicalJson(before.runtimeConfig) !== canonicalJson(after.runtimeConfig) ||
    canonicalJson(before.unitsPreference) !== canonicalJson(after.unitsPreference) ||
    canonicalJson(before.athleteState) !== canonicalJson(after.athleteState)
  ) {
    fail("persisted application state did not survive the update");
  }
  return Object.freeze({
    encryptedCredentialDecrypted: true,
    credentialCiphertextPreserved: true,
    settingsPreserved: true,
    sessionPreserved: true,
    memoryPreserved: true,
    athleteDataPreserved: true,
    appSupervisedWriterBeforeAndAfter: true,
    plaintextCredentialAbsent: true,
  });
}

async function seedSyntheticDurableState(athleteHome) {
  const memoryDirectory = join(athleteHome, "memory");
  const sessionsDirectory = join(athleteHome, "sessions");
  await Promise.all([
    mkdir(memoryDirectory, { recursive: true, mode: 0o700 }),
    mkdir(sessionsDirectory, { recursive: true, mode: 0o700 }),
  ]);
  const memoryPath = join(memoryDirectory, "MEMORY.md");
  const sessionPath = join(sessionsDirectory, `${persistenceChatId}.jsonl`);
  await Promise.all([
    writeFile(
      memoryPath,
      "## Athlete\n_updated: 2000-01-01\nSynthetic update continuity marker.\n",
      {
        flag: "wx",
        mode: 0o600,
      },
    ),
    writeFile(
      sessionPath,
      `${JSON.stringify({
        role: "user",
        content: "Synthetic update continuity turn.",
        ts: "2000-01-01T00:00:00.000Z",
      })}\n`,
      { flag: "wx", mode: 0o600 },
    ),
  ]);
  return Object.freeze({ memoryPath, sessionPath });
}

async function requirePrivateDigest(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    fail(`${label} is not a private regular file`);
  }
  return digestStableFile(path, label);
}

async function readPersistenceView(connection, input) {
  const credentialStatuses = await callAuthBridge(connection, "credentialStatuses");
  const [runtimeConfig, unitsPreference, athleteState] = await Promise.all([
    callRendererRpc(connection, input.athleteHome, "getRuntimeConfig", {}),
    callRendererRpc(connection, input.athleteHome, "getUnitsPreference", {}),
    callRendererRpc(connection, input.athleteHome, "getAthleteState", {}),
  ]);
  if (
    runtimeConfig.owner !== unitsPreference.owner ||
    runtimeConfig.owner !== athleteState.owner ||
    runtimeConfig.athleteHome !== unitsPreference.athleteHome ||
    runtimeConfig.athleteHome !== athleteState.athleteHome
  ) {
    fail("persisted application state crossed daemon ownership");
  }
  return Object.freeze({
    owner: runtimeConfig.owner,
    athleteHome: runtimeConfig.athleteHome,
    credentialStatuses,
    credentialCiphertext: await requirePrivateDigest(input.credentialPath, "encrypted credential"),
    memory: await requirePrivateDigest(input.memoryPath, "memory state"),
    session: await requirePrivateDigest(input.sessionPath, "session state"),
    runtimeConfig: runtimeConfig.result,
    unitsPreference: unitsPreference.result,
    athleteState: athleteState.result,
  });
}

async function seedApplicationState(connection, input) {
  const credentialWrite = await callAuthBridge(connection, "writeCredential", [
    { slot: persistenceCredentialSlot, value: input.credentialPlaintext },
  ]);
  if (
    !exactKeys(credentialWrite, ["runtimeReady", "slot", "status"]) ||
    credentialWrite.slot !== persistenceCredentialSlot ||
    credentialWrite.status !== "configured" ||
    credentialWrite.runtimeReady !== false
  ) {
    fail("synthetic credential was not stored by the application vault");
  }
  const runtimeWrite = await callRendererRpc(connection, input.athleteHome, "configureRuntime", {
    session: {
      historyTokenBudgetRatio: 0.37,
      idleMinutes: 23,
      dailyResetHour: 3,
      resetArchiveRetentionDays: 17,
      timezone: "UTC",
    },
  });
  if (
    !exactObject(runtimeWrite.result) ||
    runtimeWrite.result.status !== "applied" ||
    runtimeWrite.result.applied?.session !== true
  ) {
    fail("synthetic session settings were not stored by the application");
  }
  const unitsWrite = await callRendererRpc(connection, input.athleteHome, "setUnitsPreference", {
    value: "imperial",
  });
  if (
    canonicalJson(unitsWrite.result) !== canonicalJson({ value: "imperial", source: "cycling" })
  ) {
    fail("synthetic unit settings were not stored by the application");
  }
  const intakeWrite = await callRendererRpc(connection, input.athleteHome, "saveIntake", {
    swim_skill_floor: null,
    continuous_distance_capable: null,
    open_water_comfort: null,
    prior_bsi: false,
    clinician_cleared: null,
    injury_status: "none",
  });
  if (canonicalJson(intakeWrite.result) !== canonicalJson({ schemaVersion: 1, saved: true })) {
    fail("synthetic athlete state was not stored by the application");
  }
  return readPersistenceView(connection, input);
}

async function fileContains(path, needle) {
  let tail = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.concat([tail, chunk]);
    if (bytes.includes(needle)) return true;
    tail = bytes.subarray(Math.max(0, bytes.length - needle.length + 1));
  }
  return false;
}

async function requirePlaintextAbsent(roots, plaintext) {
  const needle = Buffer.from(plaintext, "utf8");
  let files = 0;
  const visit = async (path) => {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      } else if (entry.isDirectory()) {
        await visit(child);
      } else if (entry.isFile()) {
        files += 1;
        if (files > maximumPersistenceFiles) fail("persisted state file count is unbounded");
        if (await fileContains(child, needle)) fail("credential plaintext leaked to disk");
      }
    }
  };
  for (const root of roots) await visit(root);
  return true;
}

function exactDownloadedState(value, version) {
  return (
    exactKeys(value, ["status", "version"]) &&
    value.status === "downloaded" &&
    value.version === version
  );
}

async function waitForDownloadedState(connection, candidateVersion) {
  return waitUntil(
    "downloaded update state",
    async () => {
      const state = await evaluateRenderer(connection, "window.enduragentAuth.getUpdateState()");
      if (exactDownloadedState(state, candidateVersion)) return state;
      if (
        !exactObject(state) ||
        !["idle", "checking", "downloading"].includes(state.status) ||
        (state.status === "downloading" && state.version !== candidateVersion)
      ) {
        fail("application did not enter the expected downloaded update state");
      }
      return false;
    },
    downloadTimeoutMs,
    250,
  );
}

async function clickInstallUpdate(connection, candidateVersion) {
  const label = `Install update version ${candidateVersion}`;
  const clicked = await evaluateRenderer(
    connection,
    `(() => {
      const label = ${JSON.stringify(label)};
      const matches = [...document.querySelectorAll("button")].filter(
        (button) => button.getAttribute("aria-label") === label,
      );
      if (
        matches.length !== 1 ||
        !(matches[0] instanceof HTMLButtonElement) ||
        matches[0].disabled ||
        matches[0].textContent?.trim() !== "Update available"
      ) return false;
      matches[0].click();
      return true;
    })()`,
  );
  if (clicked !== true) fail("downloaded update sidebar action was unavailable");
}

async function readDownloadedCandidate(cacheDirectory, candidateArtifacts, candidateDigest) {
  const pending = join(cacheDirectory, "pending");
  await requireDirectory(pending, "downloaded update directory");
  const expectedNames = [candidateArtifacts.names.zip, "update-info.json"].sort();
  const actualNames = (await readdir(pending)).sort();
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail("downloaded update directory differs from the sealed candidate");
  }
  const info = parseMacosDownloadedUpdateInfo(
    await readStableJson(join(pending, "update-info.json"), "downloaded update metadata"),
    { fileName: candidateArtifacts.names.zip, sha512: candidateArtifacts.zipSha512 },
  );
  const downloadedPath = join(pending, info.fileName);
  const downloadedDigest = await digestStableFile(downloadedPath, "downloaded update ZIP");
  if (
    downloadedDigest.size !== candidateDigest.size ||
    downloadedDigest.sha256 !== candidateDigest.sha256 ||
    downloadedDigest.sha512 !== candidateDigest.sha512
  ) {
    fail("downloaded ZIP digest differs from the sealed candidate");
  }
  await compareStableFiles(
    candidateArtifacts.paths.zip,
    candidateDigest,
    downloadedPath,
    downloadedDigest,
  );
  return Object.freeze({ info, digest: downloadedDigest });
}

function requireArtifactDigest(artifacts, digest, label) {
  if (digest.size !== artifacts.sizes.zip || digest.sha512 !== artifacts.zipSha512) {
    fail(`${label} ZIP digest does not match its verified release envelope`);
  }
}

async function verifyArtifactsForVersion(envelope, version) {
  return verifyMacosReleaseArtifacts(envelope, {
    readVersionFile: async () => JSON.stringify({ version }),
  });
}

function directoryIdentity(stat) {
  return Object.freeze({ dev: stat.dev, ino: stat.ino, mode: stat.mode });
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

async function createPrivateScratch() {
  const temporaryRoot = await realpath("/tmp");
  const prefix = join(temporaryRoot, "enduragent-update-roundtrip-");
  const path = await mkdtemp(prefix);
  const stat = await requireDirectory(path, "round-trip scratch directory");
  if (
    dirname(path) !== dirname(prefix) ||
    path === prefix ||
    !basename(path).startsWith(basename(prefix)) ||
    (stat.mode & 0o777) !== 0o700
  ) {
    fail("round-trip scratch directory is invalid");
  }
  return Object.freeze({ path, identity: directoryIdentity(stat) });
}

async function removePrivateScratch(scratch) {
  const stat = await requireDirectory(scratch.path, "round-trip scratch directory");
  if (!sameDirectoryIdentity(scratch.identity, directoryIdentity(stat))) {
    fail("round-trip scratch directory changed before cleanup");
  }
  await rm(scratch.path, { recursive: true, force: true });
  try {
    await lstat(scratch.path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
  }
  fail("round-trip scratch cleanup failed");
}

async function writeEvidence(path, evidence) {
  await requireDirectory(dirname(path), "round-trip evidence directory");
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch {
    fail("round-trip evidence must be written to a new file");
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== Buffer.byteLength(bytes)) {
    fail("round-trip evidence file is invalid");
  }
}

export function createMacosUpdaterRoundTripEvidence(input) {
  let baselineVersion;
  let candidateVersion;
  try {
    baselineVersion = requireStableSemVer(input?.baselineVersion);
    candidateVersion = requireStableSemVer(input?.candidateVersion);
  } catch {
    fail("round-trip evidence is invalid");
  }
  if (
    !exactObject(input) ||
    !olderStableSemVer(baselineVersion, candidateVersion) ||
    !Number.isSafeInteger(input.initialPid) ||
    input.initialPid < 1 ||
    !Number.isSafeInteger(input.relaunchedPid) ||
    input.relaunchedPid < 1 ||
    input.initialPid === input.relaunchedPid ||
    !exactKeys(input.identity, [
      "bundleIdentifier",
      "teamIdentifier",
      "designatedRequirementSha256",
      "baselineCodeDirectorySha256",
      "candidateCodeDirectorySha256",
      "candidateCdHash",
    ]) ||
    typeof input.identity.bundleIdentifier !== "string" ||
    input.identity.bundleIdentifier.length === 0 ||
    typeof input.identity.teamIdentifier !== "string" ||
    input.identity.teamIdentifier.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(input.identity.designatedRequirementSha256) ||
    !/^[0-9a-f]{64}$/u.test(input.identity.baselineCodeDirectorySha256) ||
    !/^[0-9a-f]{64}$/u.test(input.identity.candidateCodeDirectorySha256) ||
    input.identity.baselineCodeDirectorySha256 === input.identity.candidateCodeDirectorySha256 ||
    !/^[0-9a-f]{40}$/u.test(input.identity.candidateCdHash) ||
    input.identity.candidateCdHash !== input.identity.candidateCodeDirectorySha256.slice(0, 40) ||
    !exactKeys(input.download, ["fileName", "size", "sha256", "sha512"]) ||
    typeof input.download.fileName !== "string" ||
    basename(input.download.fileName) !== input.download.fileName ||
    !input.download.fileName.endsWith(".zip") ||
    !Number.isSafeInteger(input.download.size) ||
    input.download.size < 1 ||
    !/^[0-9a-f]{64}$/u.test(input.download.sha256) ||
    typeof input.download.sha512 !== "string" ||
    input.download.sha512.length === 0 ||
    input.download.sha512.length > 256 ||
    !exactKeys(input.persistence, [
      "appSupervisedWriterBeforeAndAfter",
      "athleteDataPreserved",
      "credentialCiphertextPreserved",
      "encryptedCredentialDecrypted",
      "memoryPreserved",
      "plaintextCredentialAbsent",
      "sessionPreserved",
      "settingsPreserved",
    ]) ||
    Object.values(input.persistence).some((value) => value !== true)
  ) {
    fail("round-trip evidence is invalid");
  }
  return Object.freeze({
    schemaVersion: 1,
    status: "passed",
    platform: "darwin-arm64",
    baselineVersion,
    candidateVersion,
    feedUrl: MACOS_UPDATER_ROUND_TRIP_FEED_URL,
    download: Object.freeze({
      fileName: input.download.fileName,
      size: input.download.size,
      sha256: input.download.sha256,
      sha512: input.download.sha512,
      exactBytes: true,
      updateInfoBound: true,
    }),
    application: Object.freeze({
      ...input.identity,
      installedPathPreserved: true,
      initialPid: input.initialPid,
      relaunchedPid: input.relaunchedPid,
    }),
    lifecycle: Object.freeze({
      downloadedStateObserved: true,
      sidebarInstallActionInvoked: true,
      initialApplicationExitedCleanly: true,
      relaunchedApplicationObserved: true,
      oldApplicationProcessesGone: true,
      finalShutdownSignal: "SIGTERM",
      finalShutdownEscalated: false,
      noOrphanBundleProcesses: true,
    }),
    persistence: Object.freeze({ ...input.persistence }),
  });
}

export async function runMacosUpdaterRoundTrip(rawInput, overrides = {}) {
  const input = requireMacosUpdaterRoundTripInput(rawInput, {
    platform: overrides.platform,
    arch: overrides.arch,
    mode: overrides.mode,
  });
  const verifyArtifacts = overrides.verifyArtifacts ?? verifyArtifactsForVersion;
  const inspectApplication = overrides.inspectApplication ?? inspectMacosReleaseApplication;
  const createScratch = overrides.createScratch ?? createPrivateScratch;
  const removeScratch = overrides.removeScratch ?? removePrivateScratch;
  const observeProcesses = overrides.observeProcesses ?? observeApplicationProcesses;
  const writeEvidenceFile = overrides.writeEvidence ?? writeEvidence;
  const baselineArtifacts = await verifyArtifacts(input.baselineEnvelope, input.baselineVersion);
  const candidateArtifacts = await verifyArtifacts(input.candidateEnvelope, input.candidateVersion);
  if (
    baselineArtifacts?.version !== input.baselineVersion ||
    candidateArtifacts?.version !== input.candidateVersion
  ) {
    fail("verified release envelope version is invalid");
  }
  const [baselineDigest, candidateDigest] = await Promise.all([
    digestStableFile(baselineArtifacts.paths.zip, "baseline release ZIP"),
    digestStableFile(candidateArtifacts.paths.zip, "candidate release ZIP"),
  ]);
  requireArtifactDigest(baselineArtifacts, baselineDigest, "baseline");
  requireArtifactDigest(candidateArtifacts, candidateDigest, "candidate");

  const scratch = await createScratch();
  let initialChild;
  let verificationChild;
  let relaunchedPid;
  let debuggerConnection;
  let verificationConnection;
  let installedApplication;
  let completed = false;
  try {
    const baselineApplication = await extractSingleApplication(
      baselineArtifacts.paths.zip,
      join(scratch.path, "baseline"),
    );
    const candidateApplication = await extractSingleApplication(
      candidateArtifacts.paths.zip,
      join(scratch.path, "candidate"),
    );
    const installRoot = join(scratch.path, "installed");
    await mkdir(installRoot, { mode: 0o700 });
    installedApplication = join(installRoot, `${productName}.app`);
    await installApplication(baselineApplication, installedApplication);
    const [baselineIdentity, candidateIdentity, installedBaselineIdentity] = await Promise.all([
      inspectApplication(baselineApplication),
      inspectApplication(candidateApplication),
      inspectApplication(installedApplication),
    ]);
    const updaterCache = join(scratch.path, "home/Library/Caches", DESKTOP_UPDATER_CACHE_DIRECTORY);
    await requireMissing(updaterCache, "round-trip updater cache");
    const home = join(scratch.path, "home");
    const athleteHome = join(scratch.path, "athlete");
    const userData = join(scratch.path, "user-data");
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(athleteHome, { recursive: true, mode: 0o700 }),
      mkdir(userData, { recursive: true, mode: 0o700 }),
    ]);
    const durableState = await seedSyntheticDurableState(athleteHome);
    const credentialPlaintext = `enduragent-update-${randomBytes(32).toString("hex")}`;
    const credentialPath = join(
      userData,
      credentialDirectoryName,
      `${persistenceCredentialSlot}.bin`,
    );
    const debuggerPort = await reservePort();
    const executable = join(installedApplication, `Contents/MacOS/${productName}`);
    const environment = {
      ...process.env,
      HOME: home,
      ENDURAGENT_HOME: athleteHome,
      FORCE_COLOR: undefined,
      NO_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
    };
    initialChild = spawn(
      executable,
      [`--user-data-dir=${userData}`, `--remote-debugging-port=${debuggerPort}`],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    initialChild.stdout?.resume();
    initialChild.stderr?.resume();
    const childLifecycle = observeTelegramAcceptanceChild(initialChild);
    const launch = await withAcceptanceDeadline(
      "baseline application launch",
      childLifecycle.launch,
      {
        timeoutMs: 30_000,
      },
    );
    if (launch.state !== "spawned") fail("baseline application could not launch");
    const initialPid = launch.pid;
    const debuggerUrl = await waitForPage(debuggerPort, { timeoutMs: 60_000 });
    if ((await debuggerListenerOwner(debuggerPort, environment)) !== initialPid) {
      fail("baseline debugger listener is outside the installed application");
    }
    debuggerConnection = await connectCdp(debuggerUrl, () => undefined);
    await callAcceptanceCdp(debuggerConnection, "Runtime.enable");
    const persistenceInput = {
      athleteHome,
      credentialPath,
      credentialPlaintext,
      memoryPath: durableState.memoryPath,
      sessionPath: durableState.sessionPath,
    };
    const beforePersistence = await seedApplicationState(debuggerConnection, persistenceInput);
    await waitForDownloadedState(debuggerConnection, input.candidateVersion);
    const initialProcesses = await observeProcesses(installedApplication);
    if (initialProcesses.mainPids.length !== 1 || initialProcesses.mainPids[0] !== initialPid) {
      fail("baseline application process identity is ambiguous");
    }
    const downloaded = await readDownloadedCandidate(
      updaterCache,
      candidateArtifacts,
      candidateDigest,
    );
    await clickInstallUpdate(debuggerConnection, input.candidateVersion);
    const terminal = await withAcceptanceDeadline(
      "baseline application update exit",
      childLifecycle.terminal,
      { timeoutMs: transitionTimeoutMs },
    );
    debuggerConnection.socket.close();
    debuggerConnection = undefined;
    if (terminal.state !== "closed" || terminal.code !== 0 || terminal.signal !== null) {
      fail("baseline application did not exit cleanly for update");
    }
    const initialPids = new Set(initialProcesses.bundlePids);
    const relaunchedProcesses = await waitUntil(
      "relaunched candidate application",
      async () => {
        const observation = await observeProcesses(installedApplication);
        if (observation.bundlePids.some((pid) => initialPids.has(pid))) return false;
        if (observation.mainPids.length !== 1 || observation.mainPids[0] === initialPid)
          return false;
        return observation;
      },
      transitionTimeoutMs,
      250,
    );
    relaunchedPid = relaunchedProcesses.mainPids[0];
    const relaunchedIdentity = await waitUntil(
      "relaunched candidate identity",
      async () => {
        const identity = await inspectApplication(installedApplication);
        return identity.version === input.candidateVersion ? identity : false;
      },
      transitionTimeoutMs,
      250,
    );
    const identity = verifyMacosUpdaterRoundTripIdentities({
      baselineVersion: input.baselineVersion,
      candidateVersion: input.candidateVersion,
      expectedFeedUrl: MACOS_UPDATER_ROUND_TRIP_FEED_URL,
      baseline: baselineIdentity,
      candidate: candidateIdentity,
      installedBaseline: installedBaselineIdentity,
      relaunched: relaunchedIdentity,
    });
    const beforeFinalShutdown = await observeProcesses(installedApplication);
    if (
      beforeFinalShutdown.mainPids.length !== 1 ||
      beforeFinalShutdown.mainPids[0] !== relaunchedPid
    ) {
      fail("relaunched application process identity changed before shutdown");
    }
    process.kill(relaunchedPid, "SIGTERM");
    await waitUntil(
      "relaunched application graceful shutdown",
      async () => {
        const observation = await observeProcesses(installedApplication);
        return observation.bundlePids.length === 0 ? true : false;
      },
      shutdownTimeoutMs,
      100,
    );
    const verificationPort = await reservePort();
    verificationChild = spawn(
      executable,
      [`--user-data-dir=${userData}`, `--remote-debugging-port=${verificationPort}`],
      { env: environment, stdio: ["ignore", "pipe", "pipe"] },
    );
    verificationChild.stdout?.resume();
    verificationChild.stderr?.resume();
    const verificationLifecycle = observeTelegramAcceptanceChild(verificationChild);
    const verificationLaunch = await withAcceptanceDeadline(
      "candidate persistence verification launch",
      verificationLifecycle.launch,
      { timeoutMs: 30_000 },
    );
    if (verificationLaunch.state !== "spawned") {
      fail("candidate persistence verification could not launch");
    }
    const verificationUrl = await waitForPage(verificationPort, { timeoutMs: 60_000 });
    if ((await debuggerListenerOwner(verificationPort, environment)) !== verificationLaunch.pid) {
      fail("candidate persistence debugger listener is outside the installed application");
    }
    verificationConnection = await connectCdp(verificationUrl, () => undefined);
    await callAcceptanceCdp(verificationConnection, "Runtime.enable");
    const afterPersistence = await readPersistenceView(verificationConnection, persistenceInput);
    verificationChild.kill("SIGTERM");
    const verificationTerminal = await withAcceptanceDeadline(
      "candidate persistence verification shutdown",
      verificationLifecycle.terminal,
      { timeoutMs: shutdownTimeoutMs },
    );
    verificationConnection.socket.close();
    verificationConnection = undefined;
    if (
      verificationTerminal.state !== "closed" ||
      verificationTerminal.code !== 0 ||
      verificationTerminal.signal !== null
    ) {
      fail("candidate persistence verification did not exit cleanly");
    }
    await waitUntil(
      "candidate persistence verification process cleanup",
      async () => {
        const observation = await observeProcesses(installedApplication);
        return observation.bundlePids.length === 0 ? true : false;
      },
      shutdownTimeoutMs,
      100,
    );
    const plaintextCredentialAbsent = await requirePlaintextAbsent(
      [home, userData, athleteHome],
      credentialPlaintext,
    );
    const persistence = verifyMacosUpdaterRoundTripPersistence({
      before: beforePersistence,
      after: afterPersistence,
      plaintextCredentialAbsent,
    });
    const evidence = createMacosUpdaterRoundTripEvidence({
      baselineVersion: input.baselineVersion,
      candidateVersion: input.candidateVersion,
      initialPid,
      relaunchedPid,
      identity,
      download: {
        fileName: downloaded.info.fileName,
        size: downloaded.digest.size,
        sha256: downloaded.digest.sha256,
        sha512: downloaded.digest.sha512,
      },
      persistence,
    });
    await removeScratch(scratch);
    await writeEvidenceFile(input.evidencePath, evidence);
    completed = true;
    return evidence;
  } finally {
    try {
      debuggerConnection?.socket.close();
    } catch {}
    try {
      verificationConnection?.socket.close();
    } catch {}
    if (!completed) {
      if (
        initialChild !== undefined &&
        initialChild.exitCode === null &&
        initialChild.signalCode === null
      ) {
        try {
          initialChild.kill("SIGTERM");
        } catch {}
      }
      if (
        verificationChild !== undefined &&
        verificationChild.exitCode === null &&
        verificationChild.signalCode === null
      ) {
        try {
          verificationChild.kill("SIGTERM");
        } catch {}
      }
      if (
        installedApplication !== undefined &&
        Number.isSafeInteger(relaunchedPid) &&
        relaunchedPid > 0
      ) {
        try {
          const observation = await observeProcesses(installedApplication);
          if (observation.mainPids.includes(relaunchedPid)) {
            process.kill(relaunchedPid, "SIGTERM");
          }
        } catch {}
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 5)
    fail("expected baseline version, candidate version, two envelopes, and evidence path");
  await runMacosUpdaterRoundTrip({
    baselineVersion: args[0],
    candidateVersion: args[1],
    baselineEnvelope: args[2],
    candidateEnvelope: args[3],
    evidencePath: args[4],
  });
  process.stdout.write("macOS updater round trip verified\n");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch {
    process.stderr.write("macOS updater round trip failed\n");
    process.exitCode = 1;
  }
}
