import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KEYCHAIN_HELPER_RESOURCE_PATH } from "./package-inventory.mjs";
import { verifyMacosKeychainHelper } from "./verify-macos-release.mjs";

export const BACKEND_SELECTION_SERVICE = "icu.enduragent.desktop";
export const BACKEND_SELECTION_TEAM_IDENTIFIER = "FA494ACVTF";
export const BACKEND_SELECTION_PROBE_TIMEOUT_MS = 15_000;
export const BACKEND_SELECTION_MAX_RESPONSE_BYTES = 8_192;

class MacosBackendSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "MacosBackendSelectionError";
  }
}

function fail(message) {
  throw new MacosBackendSelectionError(message);
}

export function safeMacosBackendSelectionMessage(error) {
  return error instanceof MacosBackendSelectionError ? error.message : undefined;
}

export function backendSelectionProbeRequest() {
  return `${JSON.stringify({ op: "probe", service: BACKEND_SELECTION_SERVICE })}\n`;
}

async function requireExecutableHelper(helper) {
  let entry;
  try {
    entry = await lstat(helper);
  } catch {
    fail("bundled keychain helper is missing");
  }
  if (!entry.isFile()) fail("bundled keychain helper is not a regular file");
  try {
    await access(helper, constants.X_OK);
  } catch {
    fail("bundled keychain helper is not executable");
  }
}

function runBundledHelper(helper, request) {
  return new Promise((resolveLine, rejectLine) => {
    let child;
    try {
      child = spawn(helper, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      rejectLine(new MacosBackendSelectionError("bundled keychain helper could not be launched"));
      return;
    }
    let settled = false;
    let received = "";
    const finish = (line, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {}
      if (message === undefined) resolveLine(line);
      else rejectLine(new MacosBackendSelectionError(message));
    };
    const timer = setTimeout(
      () => finish(undefined, "bundled keychain helper probe timed out"),
      BACKEND_SELECTION_PROBE_TIMEOUT_MS,
    );
    child.once("error", () => finish(undefined, "bundled keychain helper could not be launched"));
    child.once("close", () => {
      const newline = received.indexOf("\n");
      finish(newline < 0 ? received : received.slice(0, newline));
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      received += chunk;
      if (Buffer.byteLength(received, "utf8") > BACKEND_SELECTION_MAX_RESPONSE_BYTES) {
        finish(undefined, "bundled keychain helper answered too much output");
        return;
      }
      const newline = received.indexOf("\n");
      if (newline >= 0) finish(received.slice(0, newline));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(request);
  });
}

function parseProbeAnswer(line) {
  if (typeof line !== "string" || line.length === 0) {
    fail("bundled keychain helper answered nothing");
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail("bundled keychain helper answered malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("bundled keychain helper answered malformed JSON");
  }
  if (parsed.ok !== true || parsed.op !== "probe") {
    fail("bundled keychain helper refused the capability probe");
  }
  if (parsed.teamIdentifier !== BACKEND_SELECTION_TEAM_IDENTIFIER) {
    fail("bundled keychain helper reported an unexpected team identifier");
  }
  return parsed.teamIdentifier;
}

export async function verifyMacosBackendSelection(application, overrides = {}) {
  if (typeof application !== "string" || !isAbsolute(application)) {
    fail("application path must be absolute");
  }
  const helper = join(application, "Contents/Resources", KEYCHAIN_HELPER_RESOURCE_PATH);
  await (overrides.requireHelper ?? requireExecutableHelper)(helper);
  const verifyHelperSignature =
    overrides.verifyKeychainHelper ??
    ((candidate) => verifyMacosKeychainHelper(candidate, { executeFile: overrides.executeFile }));
  let signature;
  try {
    signature = await verifyHelperSignature(application);
  } catch (error) {
    fail(
      typeof error?.message === "string" && error.message.length > 0
        ? error.message
        : "bundled keychain helper signature verification failed",
    );
  }
  if (
    typeof signature !== "object" ||
    signature === null ||
    signature.teamIdentifier !== BACKEND_SELECTION_TEAM_IDENTIFIER
  ) {
    fail("bundled keychain helper signing identity is invalid");
  }
  const runHelper = overrides.runHelper ?? runBundledHelper;
  const teamIdentifier = parseProbeAnswer(await runHelper(helper, backendSelectionProbeRequest()));
  return Object.freeze({
    helper,
    service: BACKEND_SELECTION_SERVICE,
    teamIdentifier,
    designatedRequirement: signature.designatedRequirement,
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [application] = process.argv.slice(2);
    if (application === undefined) fail("expected an absolute application path");
    await verifyMacosBackendSelection(application);
    process.stdout.write("macOS keychain backend selection verified\n");
  } catch (error) {
    process.stderr.write(
      `${safeMacosBackendSelectionMessage(error) ?? "macOS keychain backend selection verification failed"}\n`,
    );
    process.exitCode = 1;
  }
}
