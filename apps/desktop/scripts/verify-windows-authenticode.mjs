import { execFile } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  parseWindowsReleaseProvenance,
  requireReleaseCommit,
  windowsUpdaterPublisherDigest,
} from "./windows-release-plan.mjs";

export const WINDOWS_AUTHENTICODE_SUMMARY_SCHEMA = "windows-authenticode-verification/2";
export const WINDOWS_AUTHENTICODE_REQUIRED_CHECKS = Object.freeze([
  "file",
  "status",
  "digest",
  "timestamp",
  "subject",
  "chain",
  "signtool",
]);

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const canonicalScriptPath = resolve(scriptDirectory, "verify-windows-authenticode.ps1");
const executeSystemFile = promisify(execFile);
const maximumCommandOutputBytes = 4 * 1024 * 1024;
const safeMessages = new Set([
  "Authenticode signature is not valid",
  "Authenticode digest is not SHA-256",
  "Authenticode timestamp is missing",
  "Authenticode publisher mismatch",
  "Authenticode thumbprint mismatch",
  "Authenticode chain is untrusted",
  "Authenticode provenance mismatch",
  "signtool verification failed",
  "Authenticode summary is invalid",
  "PowerShell 7 is required for Authenticode verification",
]);

class WindowsAuthenticodeError extends TypeError {
  constructor(message) {
    super(message);
    this.name = "WindowsAuthenticodeError";
  }
}

function fail(message) {
  throw new WindowsAuthenticodeError(message);
}

export function safeWindowsAuthenticodeMessage(error) {
  return error instanceof WindowsAuthenticodeError && safeMessages.has(error.message)
    ? error.message
    : undefined;
}

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function nullableString(value) {
  return value === null || typeof value === "string";
}

function validSummary(summary) {
  if (
    !exactObject(summary) ||
    !hasExactKeys(summary, [
      "schema",
      "installerPath",
      "ok",
      "signer",
      "timestamper",
      "status",
      "statusMessage",
      "digestAlgorithm",
      "rfc3161",
      "signtool",
      "versionInfo",
      "allowSelfSignedTest",
      "checks",
    ]) ||
    summary.schema !== WINDOWS_AUTHENTICODE_SUMMARY_SCHEMA ||
    typeof summary.installerPath !== "string" ||
    typeof summary.ok !== "boolean" ||
    !nullableString(summary.status) ||
    !nullableString(summary.statusMessage) ||
    !nullableString(summary.digestAlgorithm) ||
    typeof summary.rfc3161 !== "boolean" ||
    typeof summary.allowSelfSignedTest !== "boolean"
  ) {
    return false;
  }
  if (
    summary.signer !== null &&
    (!exactObject(summary.signer) ||
      !hasExactKeys(summary.signer, ["subject", "thumbprint", "issuer", "notAfter"]) ||
      ![summary.signer.subject, summary.signer.thumbprint, summary.signer.issuer, summary.signer.notAfter].every(
        (value) => typeof value === "string",
      ))
  ) {
    return false;
  }
  if (
    summary.timestamper !== null &&
    (!exactObject(summary.timestamper) ||
      !hasExactKeys(summary.timestamper, ["subject"]) ||
      typeof summary.timestamper.subject !== "string")
  ) {
    return false;
  }
  if (
    !exactObject(summary.signtool) ||
    !hasExactKeys(summary.signtool, ["path", "exitCode", "output"]) ||
    !nullableString(summary.signtool.path) ||
    !(summary.signtool.exitCode === null || Number.isSafeInteger(summary.signtool.exitCode)) ||
    typeof summary.signtool.output !== "string"
  ) {
    return false;
  }
  if (
    !exactObject(summary.versionInfo) ||
    !hasExactKeys(summary.versionInfo, ["productVersion", "legalTrademarks"]) ||
    !nullableString(summary.versionInfo.productVersion) ||
    !nullableString(summary.versionInfo.legalTrademarks)
  ) {
    return false;
  }
  if (
    !Array.isArray(summary.checks) ||
    !summary.checks.every(
      (check) =>
        exactObject(check) &&
        hasExactKeys(check, ["name", "ok", "detail"]) &&
        typeof check.name === "string" &&
        typeof check.ok === "boolean" &&
        typeof check.detail === "string",
    ) ||
    new Set(summary.checks.map((check) => check.name)).size !== summary.checks.length
  ) {
    return false;
  }
  return true;
}

export function parseWindowsAuthenticodeSummary(stdout) {
  if (typeof stdout !== "string") fail("Authenticode summary is invalid");
  let summary;
  try {
    summary = JSON.parse(stdout);
  } catch {
    fail("Authenticode summary is invalid");
  }
  if (!validSummary(summary)) fail("Authenticode summary is invalid");
  return summary;
}

function checkMap(summary) {
  return new Map(summary.checks.map((check) => [check.name, check]));
}

function validExpectedValues(expectedPublisherDn, expectedThumbprint, expectedCommit) {
  return (
    typeof expectedPublisherDn === "string" &&
    expectedPublisherDn.length > 0 &&
    expectedPublisherDn === expectedPublisherDn.trim() &&
    (expectedThumbprint === undefined || /^[0-9a-f]{40}$/iu.test(expectedThumbprint)) &&
    (expectedCommit === undefined || /^[0-9a-f]{40}$/u.test(expectedCommit))
  );
}

function provenanceMatches(summary, expectedCommit, expectedVersion, expectedPublisherDn) {
  if (expectedCommit !== undefined) {
    const provenance = parseWindowsReleaseProvenance(summary.versionInfo.legalTrademarks);
    if (
      provenance === null ||
      provenance.commit !== expectedCommit ||
      provenance.publisherSha256 !== windowsUpdaterPublisherDigest(expectedPublisherDn)
    ) {
      return false;
    }
  }
  if (expectedVersion !== undefined && summary.versionInfo.productVersion !== expectedVersion) {
    return false;
  }
  return true;
}

export function decideWindowsAuthenticode(
  summary,
  { expectedPublisherDn, expectedThumbprint, expectedCommit, expectedVersion, allowSelfSignedTest = false },
) {
  if (
    !validSummary(summary) ||
    !validExpectedValues(expectedPublisherDn, expectedThumbprint, expectedCommit) ||
    (expectedVersion !== undefined && typeof expectedVersion !== "string") ||
    typeof allowSelfSignedTest !== "boolean" ||
    summary.allowSelfSignedTest !== allowSelfSignedTest
  ) {
    fail("Authenticode summary is invalid");
  }
  const checks = checkMap(summary);
  const required =
    expectedThumbprint === undefined
      ? WINDOWS_AUTHENTICODE_REQUIRED_CHECKS
      : [...WINDOWS_AUTHENTICODE_REQUIRED_CHECKS, "thumbprint"];
  if (required.some((name) => !checks.has(name))) fail("Authenticode summary is invalid");
  const untrustedStatus = summary.status === "NotTrusted" || summary.status === "UnknownError";
  const testTrustAccepted =
    allowSelfSignedTest &&
    expectedThumbprint !== undefined &&
    untrustedStatus &&
    typeof summary.statusMessage === "string" &&
    /untrusted root|root certificate which is not trusted|terminated in a root certificate/iu.test(
      summary.statusMessage,
    ) &&
    checks.get("chain").detail === "untrusted-root-accepted-for-test";
  if (!checks.get("file").ok) fail("Authenticode signature is not valid");
  if (summary.status !== "Valid" && !untrustedStatus) {
    fail("Authenticode signature is not valid");
  }
  if (!checks.get("digest").ok || summary.digestAlgorithm !== "sha256") {
    fail("Authenticode digest is not SHA-256");
  }
  if (!checks.get("timestamp").ok || !summary.rfc3161 || summary.timestamper === null) {
    fail("Authenticode timestamp is missing");
  }
  if (
    !checks.get("subject").ok ||
    summary.signer === null ||
    summary.signer.subject !== expectedPublisherDn
  ) {
    fail("Authenticode publisher mismatch");
  }
  if (
    expectedThumbprint !== undefined &&
    (!checks.get("thumbprint").ok ||
      summary.signer.thumbprint.toLowerCase() !== expectedThumbprint.toLowerCase())
  ) {
    fail("Authenticode thumbprint mismatch");
  }
  if (!checks.get("chain").ok || (untrustedStatus && !testTrustAccepted)) {
    fail("Authenticode chain is untrusted");
  }
  if (!checks.get("signtool").ok) fail("signtool verification failed");
  if (!provenanceMatches(summary, expectedCommit, expectedVersion, expectedPublisherDn)) {
    fail("Authenticode provenance mismatch");
  }
  if (!checks.get("status").ok || !summary.ok || summary.checks.some((check) => !check.ok)) {
    fail("Authenticode signature is not valid");
  }
  return Object.freeze({
    ok: true,
    signer: Object.freeze({ ...summary.signer }),
    digestAlgorithm: "sha256",
    rfc3161: true,
  });
}

function outputStream(result, name) {
  if (typeof result === "string" || Buffer.isBuffer(result)) {
    return name === "stdout" ? String(result) : "";
  }
  if (!exactObject(result)) return "";
  const value = result[name];
  return typeof value === "string" || Buffer.isBuffer(value) ? String(value) : "";
}

async function runWindowsAuthenticode(options, dependencies = {}) {
  if (
    !exactObject(options) ||
    !isAbsolute(options.installerPath) ||
    !validExpectedValues(
      options.expectedPublisherDn,
      options.expectedThumbprint,
      options.expectedCommit,
    )
  ) {
    fail("Authenticode summary is invalid");
  }
  const scriptPath = dependencies.scriptPath ?? canonicalScriptPath;
  if (!isAbsolute(scriptPath)) fail("Authenticode summary is invalid");
  const arguments_ = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-InstallerPath",
    options.installerPath,
    "-ExpectedPublisherDn",
    options.expectedPublisherDn,
  ];
  if (options.expectedThumbprint !== undefined) {
    arguments_.push("-ExpectedThumbprint", options.expectedThumbprint);
  }
  if (options.allowSelfSignedTest === true) arguments_.push("-AllowSelfSignedTest");
  if (options.allowMissingSigntool === true) arguments_.push("-AllowMissingSigntool");
  const executeFile = dependencies.executeFile ?? executeSystemFile;
  let result;
  try {
    result = await executeFile("pwsh", arguments_, {
      encoding: "utf8",
      maxBuffer: maximumCommandOutputBytes,
    });
  } catch (error) {
    if (exactObject(error) && error.code === "ENOENT") {
      fail("PowerShell 7 is required for Authenticode verification");
    }
    if (exactObject(error) && error.code === 1) {
      result = error;
    } else {
      fail("Authenticode summary is invalid");
    }
  }
  if (exactObject(result) && Object.hasOwn(result, "exitCode") && ![0, 1].includes(result.exitCode)) {
    fail("Authenticode summary is invalid");
  }
  return parseWindowsAuthenticodeSummary(outputStream(result, "stdout"));
}

export async function verifyWindowsAuthenticode(options, dependencies = {}) {
  const summary = await runWindowsAuthenticode(options, dependencies);
  return decideWindowsAuthenticode(summary, {
    expectedPublisherDn: options.expectedPublisherDn,
    expectedThumbprint: options.expectedThumbprint,
    expectedCommit: options.expectedCommit,
    expectedVersion: options.expectedVersion,
    allowSelfSignedTest: options.allowSelfSignedTest ?? false,
  });
}

export function createWindowsAuthenticodeVerifyMode(options, dependencies = {}) {
  if (
    !exactObject(options) ||
    !validExpectedValues(options.expectedPublisherDn, options.expectedThumbprint)
  ) {
    fail("Authenticode summary is invalid");
  }
  const expectedPublisherDn = options.expectedPublisherDn;
  return Object.freeze({
    mode: "verify",
    expectedPublisherDn,
    async verify(installerPath, context) {
      if (
        context?.publisherName !== undefined &&
        context.publisherName !== expectedPublisherDn
      ) {
        fail("Authenticode publisher mismatch");
      }
      let expectedCommit;
      try {
        expectedCommit = requireReleaseCommit(context?.commit);
      } catch {
        fail("Authenticode provenance mismatch");
      }
      await verifyWindowsAuthenticode(
        {
          installerPath,
          expectedPublisherDn,
          expectedThumbprint: options.expectedThumbprint,
          expectedCommit,
          expectedVersion: context.version,
          allowSelfSignedTest: options.allowSelfSignedTest,
          allowMissingSigntool: options.allowMissingSigntool,
        },
        dependencies,
      );
    },
  });
}

function parseArguments(arguments_) {
  let installerPath;
  let expectedPublisherDn;
  let expectedThumbprint;
  let expectedCommit;
  let allowSelfSignedTest = false;
  let allowMissingSigntool = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!argument.startsWith("--") && installerPath === undefined) {
      installerPath = argument;
      continue;
    }
    if (argument === "--allow-self-signed-test" && !allowSelfSignedTest) {
      allowSelfSignedTest = true;
      continue;
    }
    if (argument === "--allow-missing-signtool" && !allowMissingSigntool) {
      allowMissingSigntool = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) fail("Authenticode summary is invalid");
    index += 1;
    if (argument === "--publisher-dn" && expectedPublisherDn === undefined) {
      expectedPublisherDn = value;
    } else if (argument === "--thumbprint" && expectedThumbprint === undefined) {
      expectedThumbprint = value;
    } else if (argument === "--commit" && expectedCommit === undefined) {
      expectedCommit = value;
    } else {
      fail("Authenticode summary is invalid");
    }
  }
  if (installerPath === undefined || expectedPublisherDn === undefined) {
    fail("Authenticode summary is invalid");
  }
  return {
    installerPath: resolve(installerPath),
    expectedPublisherDn,
    expectedThumbprint,
    expectedCommit,
    allowSelfSignedTest,
    allowMissingSigntool,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const summary = await runWindowsAuthenticode(options);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  try {
    decideWindowsAuthenticode(summary, options);
  } catch (error) {
    process.stderr.write(`${safeWindowsAuthenticodeMessage(error) ?? "Authenticode verification failed"}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${safeWindowsAuthenticodeMessage(error) ?? "Authenticode verification failed"}\n`);
    process.exitCode = 1;
  }
}
