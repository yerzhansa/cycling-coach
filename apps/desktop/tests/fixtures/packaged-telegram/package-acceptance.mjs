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

function requireLine(lines, expected, message) {
  if (!lines.includes(expected)) throw new TypeError(message);
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
  requireLine(
    lines,
    `Identifier=${TELEGRAM_ACCEPTANCE_APP_ID}`,
    "Telegram acceptance signature identifier is invalid",
  );
  requireLine(lines, "Signature=adhoc", "Telegram acceptance signature is not ad-hoc");
  requireLine(
    lines,
    "TeamIdentifier=not set",
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

export function verifyTelegramAcceptanceDesignatedRequirement(value) {
  if (
    typeof value !== "string" ||
    value.trim().replaceAll(/\s+/gu, " ") !==
      `designated => identifier "${TELEGRAM_ACCEPTANCE_APP_ID}"`
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
    value.version !== expectedVersion
  ) {
    throw new TypeError("Telegram acceptance ASAR manifest identity is invalid");
  }
}
