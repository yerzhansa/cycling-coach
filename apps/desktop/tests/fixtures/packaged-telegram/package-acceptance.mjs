import { isAbsolute, relative, sep } from "node:path";
import ts from "typescript";

export const TELEGRAM_ACCEPTANCE_APP_ID = "icu.enduragent.desktop.telegram-acceptance";
export const TELEGRAM_ACCEPTANCE_PACKAGE_NAME = "enduragent-desktop-telegram-acceptance";
export const TELEGRAM_ACCEPTANCE_PRODUCT_NAME = "Enduragent Telegram Acceptance";
export const TELEGRAM_ACCEPTANCE_MARKER = "enduragentDesktopTelegramAcceptance";
export const TELEGRAM_ACCEPTANCE_ENTITLEMENTS = Object.freeze({
  "com.apple.security.cs.allow-jit": true,
});

function exactObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireUniqueLine(lines, prefix, expected, message) {
  const matches = lines.filter((line) => line.startsWith(`${prefix}=`));
  if (matches.length !== 1 || matches[0] !== `${prefix}=${expected}`) {
    throw new TypeError(message);
  }
}

function requirePositiveLine(lines, pattern, message) {
  const match = lines.map((line) => pattern.exec(line)).find((candidate) => candidate !== null);
  if (match === undefined || match.slice(1).some((value) => Number(value) < 1)) {
    throw new TypeError(message);
  }
}

export function createTelegramAcceptanceBuilderConfiguration(canonical) {
  if (
    !exactObject(canonical) ||
    !Array.isArray(canonical.files) ||
    !exactObject(canonical.directories) ||
    !exactObject(canonical.mac) ||
    (canonical.extraMetadata !== undefined && !exactObject(canonical.extraMetadata))
  ) {
    throw new TypeError("canonical Desktop builder configuration is invalid");
  }
  const matches = canonical.files.filter((entry) => entry === "out/**");
  if (matches.length !== 1) {
    throw new TypeError("canonical Desktop runtime FileSet is ambiguous");
  }
  return {
    ...canonical,
    appId: TELEGRAM_ACCEPTANCE_APP_ID,
    productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
    extraMetadata: {
      name: TELEGRAM_ACCEPTANCE_PACKAGE_NAME,
      productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
      [TELEGRAM_ACCEPTANCE_MARKER]: true,
    },
    directories: {
      ...canonical.directories,
      output: "dist/telegram-acceptance-package",
    },
    files: canonical.files.map((entry) =>
      entry === "out/**"
        ? {
            from: "dist/telegram-acceptance-build/out",
            to: "out",
            filter: ["**/*"],
          }
        : entry,
    ),
    mac: {
      ...canonical.mac,
      identity: "-",
      hardenedRuntime: false,
      entitlements: "build/entitlements.mac.plist",
      entitlementsInherit: "build/entitlements.mac.plist",
      target: [{ target: "dir", arch: ["arm64"] }],
    },
  };
}

export function verifyTelegramAcceptanceSignature(description) {
  if (typeof description !== "string") {
    throw new TypeError("Telegram acceptance signature description is invalid");
  }
  const lines = description.split(/\r?\n/u).map((line) => line.trim());
  requireUniqueLine(
    lines,
    "Identifier",
    TELEGRAM_ACCEPTANCE_APP_ID,
    "Telegram acceptance signature identifier is invalid",
  );
  requireUniqueLine(lines, "Signature", "adhoc", "Telegram acceptance signature is not ad-hoc");
  requireUniqueLine(
    lines,
    "TeamIdentifier",
    "not set",
    "Telegram acceptance signature unexpectedly has a team",
  );
  requirePositiveLine(
    lines,
    /^Info\.plist entries=(\d+)$/u,
    "Telegram acceptance signature does not bind Info.plist",
  );
  requirePositiveLine(
    lines,
    /^Sealed Resources version=(\d+) rules=(\d+) files=(\d+)$/u,
    "Telegram acceptance signature does not seal bundle resources",
  );
  requirePositiveLine(
    lines,
    /^Internal requirements count=\d+ size=(\d+)$/u,
    "Telegram acceptance signature has no internal requirements record",
  );
  const cdHashLines = lines.filter((line) => line.startsWith("CDHash="));
  if (cdHashLines.length !== 1 || !/^CDHash=[0-9a-f]{40}$/u.test(cdHashLines[0])) {
    throw new TypeError("Telegram acceptance signature code-directory hash is invalid");
  }
  return cdHashLines[0].slice("CDHash=".length);
}

export function verifyTelegramAcceptanceNestedSignature(description) {
  if (typeof description !== "string") {
    throw new TypeError("Telegram acceptance nested signature is invalid");
  }
  const lines = description.split(/\r?\n/u).map((line) => line.trim());
  const identifiers = lines.filter((line) => /^Identifier=.+$/u.test(line));
  const cdHashes = lines.filter((line) => line.startsWith("CDHash="));
  const signatures = lines.filter((line) => line.startsWith("Signature="));
  const teams = lines.filter((line) => line.startsWith("TeamIdentifier="));
  if (
    identifiers.length !== 1 ||
    cdHashes.length !== 1 ||
    !/^CDHash=[0-9a-f]{40}$/u.test(cdHashes[0]) ||
    signatures.length !== 1 ||
    signatures[0] !== "Signature=adhoc" ||
    teams.length !== 1 ||
    teams[0] !== "TeamIdentifier=not set"
  ) {
    throw new TypeError("Telegram acceptance nested signature is invalid");
  }
}

export function verifyTelegramAcceptanceInfoPlist(value) {
  if (
    !exactObject(value) ||
    value.CFBundleIdentifier !== TELEGRAM_ACCEPTANCE_APP_ID ||
    value.CFBundleName !== TELEGRAM_ACCEPTANCE_PRODUCT_NAME ||
    value.CFBundleDisplayName !== TELEGRAM_ACCEPTANCE_PRODUCT_NAME ||
    value.CFBundleExecutable !== TELEGRAM_ACCEPTANCE_PRODUCT_NAME
  ) {
    throw new TypeError("Telegram acceptance Info.plist identity is invalid");
  }
}

export function verifyTelegramAcceptanceEntitlements(value) {
  if (
    !exactObject(value) ||
    Object.keys(value).length !== 1 ||
    value["com.apple.security.cs.allow-jit"] !== true
  ) {
    throw new TypeError("Telegram acceptance signed entitlements are invalid");
  }
}

export function verifyTelegramAcceptanceNestedEntitlements(value) {
  if (value === undefined) return;
  if (
    !exactObject(value) ||
    Object.keys(value).length !== 1 ||
    value["com.apple.security.cs.allow-jit"] !== true
  ) {
    throw new TypeError("Telegram acceptance nested entitlements are invalid");
  }
}

export function verifyTelegramAcceptanceNestedListing(description) {
  if (typeof description !== "string") {
    throw new TypeError("Telegram acceptance nested code listing is invalid");
  }
  const lines = description
    .split(/\n/u)
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  const executableLines = lines.filter((line) => line.startsWith("Executable="));
  if (executableLines.length !== 1) {
    throw new TypeError("Telegram acceptance nested code listing is invalid");
  }
  const executable = executableLines[0].slice("Executable=".length);
  if (
    !executable.startsWith("/") ||
    executable.trim() !== executable ||
    executable.includes("\0")
  ) {
    throw new TypeError("Telegram acceptance nested code listing is invalid");
  }
  const nested = lines
    .filter((line) => line.startsWith("Nested="))
    .map((line) => line.slice("Nested=".length));
  const seen = new Set();
  for (const path of nested) {
    const segments = path.split("/");
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.trim() !== path ||
      path.includes("\\") ||
      path.includes("\0") ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      seen.has(path)
    ) {
      throw new TypeError("Telegram acceptance nested code listing is invalid");
    }
    seen.add(path);
  }
  return { executable, nested };
}

export function selectTelegramAcceptanceNestedTarget(applicationRoot, candidates) {
  if (
    typeof applicationRoot !== "string" ||
    !isAbsolute(applicationRoot) ||
    !Array.isArray(candidates)
  ) {
    throw new TypeError("Telegram acceptance nested code resolution is invalid");
  }
  const resolved = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !isAbsolute(candidate)) {
      throw new TypeError("Telegram acceptance nested code resolution is invalid");
    }
    const displacement = relative(applicationRoot, candidate);
    if (displacement === ".." || displacement.startsWith(`..${sep}`) || isAbsolute(displacement)) {
      throw new TypeError("Telegram acceptance nested code target escapes the application");
    }
    resolved.add(candidate);
  }
  if (resolved.size !== 1) {
    throw new TypeError(
      resolved.size === 0
        ? "Telegram acceptance nested code target is missing"
        : "Telegram acceptance nested code target is ambiguous",
    );
  }
  return resolved.values().next().value;
}

export function verifyTelegramAcceptanceDesignatedRequirement(value, expectedCdHash) {
  if (typeof expectedCdHash !== "string" || !/^[0-9a-f]{40}$/u.test(expectedCdHash)) {
    throw new TypeError("Telegram acceptance code-directory hash is invalid");
  }
  if (
    typeof value !== "string" ||
    value.trim().replaceAll(/\s+/gu, " ") !== `# designated => cdhash H"${expectedCdHash}"`
  ) {
    throw new TypeError("Telegram acceptance designated requirement is invalid");
  }
}

export function verifyTelegramAcceptanceManifest(value, expectedVersion) {
  if (
    !exactObject(value) ||
    typeof expectedVersion !== "string" ||
    expectedVersion.length === 0 ||
    value.name !== TELEGRAM_ACCEPTANCE_PACKAGE_NAME ||
    value.productName !== TELEGRAM_ACCEPTANCE_PRODUCT_NAME ||
    value[TELEGRAM_ACCEPTANCE_MARKER] !== true ||
    value.version !== expectedVersion ||
    value.type !== "module" ||
    value.main !== "out/main/index.js"
  ) {
    throw new TypeError("Telegram acceptance ASAR manifest identity is invalid");
  }
}

export function verifyTelegramAcceptanceMainEntry(value) {
  if (typeof value !== "string") {
    throw new TypeError("Telegram acceptance main entry is invalid");
  }
  const source = ts.createSourceFile(
    "telegram-acceptance-main.js",
    value,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const imports = [];
  const collectImports = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      imports.push(node);
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(source);
  const finalStatement = source.statements.at(-1);
  const finalExpression =
    finalStatement !== undefined && ts.isExpressionStatement(finalStatement)
      ? finalStatement.expression
      : undefined;
  const finalCall =
    finalExpression !== undefined && ts.isAwaitExpression(finalExpression)
      ? finalExpression.expression
      : undefined;
  const importPath =
    finalCall !== undefined &&
    ts.isCallExpression(finalCall) &&
    finalCall.expression.kind === ts.SyntaxKind.ImportKeyword &&
    finalCall.arguments.length === 1 &&
    ts.isStringLiteral(finalCall.arguments[0])
      ? finalCall.arguments[0].text
      : undefined;
  if (
    source.parseDiagnostics.length !== 0 ||
    imports.length !== 1 ||
    imports[0] !== finalCall ||
    typeof importPath !== "string" ||
    !/^\.\/index-[A-Za-z0-9_-]+\.js$/u.test(importPath)
  ) {
    throw new TypeError("Telegram acceptance production main location is invalid");
  }
  return `out/main/${importPath.slice(2)}`;
}
