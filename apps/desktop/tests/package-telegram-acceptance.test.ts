import { describe, expect, it } from "vitest";
import {
  createTelegramAcceptanceBuilderConfiguration,
  TELEGRAM_ACCEPTANCE_APP_ID,
  TELEGRAM_ACCEPTANCE_ENTITLEMENTS,
  TELEGRAM_ACCEPTANCE_MARKER,
  TELEGRAM_ACCEPTANCE_PACKAGE_NAME,
  TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
  verifyTelegramAcceptanceDesignatedRequirement,
  verifyTelegramAcceptanceEntitlements,
  verifyTelegramAcceptanceInfoPlist,
  verifyTelegramAcceptanceManifest,
  verifyTelegramAcceptanceSignature,
} from "./fixtures/packaged-telegram/package-acceptance.mjs";

const version = "0.0.1";

function canonicalBuilder() {
  return {
    appId: "icu.enduragent.desktop",
    productName: "Enduragent",
    directories: { output: "dist" },
    files: ["out/**", "package.json", "!**/*.map"],
    extraMetadata: { name: "@enduragent/desktop", retained: true },
    mac: {
      identity: "Developer ID Application: Production (ABCDE12345)",
      hardenedRuntime: true,
      target: [{ target: "dir", arch: ["arm64"] }],
    },
  };
}

function signature(overrides: Partial<Record<string, string>> = {}): string {
  return [
    `Identifier=${overrides.Identifier ?? TELEGRAM_ACCEPTANCE_APP_ID}`,
    `Signature=${overrides.Signature ?? "adhoc"}`,
    `TeamIdentifier=${overrides.TeamIdentifier ?? "not set"}`,
    overrides.InfoPlist ?? "Info.plist entries=31",
    overrides.SealedResources ?? "Sealed Resources version=2 rules=13 files=287",
    overrides.InternalRequirements ?? "Internal requirements count=0 size=12",
  ].join("\n");
}

function infoPlist() {
  return {
    CFBundleIdentifier: TELEGRAM_ACCEPTANCE_APP_ID,
    CFBundleName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
    CFBundleDisplayName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
    CFBundleExecutable: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
  };
}

function manifest() {
  return {
    name: TELEGRAM_ACCEPTANCE_PACKAGE_NAME,
    productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
    [TELEGRAM_ACCEPTANCE_MARKER]: true,
    version,
  };
}

describe("Telegram acceptance package", () => {
  it("derives a distinct ad-hoc-signed acceptance identity without mutating the canonical config", () => {
    const canonical = canonicalBuilder();
    const derived = createTelegramAcceptanceBuilderConfiguration(canonical) as {
      readonly appId: string;
      readonly productName: string;
      readonly extraMetadata: Record<string, unknown>;
      readonly directories: Record<string, unknown>;
      readonly files: readonly unknown[];
      readonly mac: Record<string, unknown>;
    };

    expect(derived).toMatchObject({
      appId: TELEGRAM_ACCEPTANCE_APP_ID,
      productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
      extraMetadata: {
        name: TELEGRAM_ACCEPTANCE_PACKAGE_NAME,
        productName: TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
        [TELEGRAM_ACCEPTANCE_MARKER]: true,
      },
      directories: { output: "dist/telegram-acceptance-package" },
      mac: {
        identity: "-",
        hardenedRuntime: false,
        entitlements: "build/entitlements.mac.plist",
        entitlementsInherit: "build/entitlements.mac.plist",
        target: [{ target: "dir", arch: ["arm64"] }],
      },
    });
    expect(derived.files[0]).toEqual({
      from: "dist/telegram-acceptance-build/out",
      to: "out",
      filter: ["**/*"],
    });
    expect(Object.keys(derived.extraMetadata).sort()).toEqual([
      TELEGRAM_ACCEPTANCE_MARKER,
      "name",
      "productName",
    ]);
    expect(canonical).toEqual(canonicalBuilder());
  });

  it("fails closed when the canonical runtime FileSet is ambiguous", () => {
    expect(() =>
      createTelegramAcceptanceBuilderConfiguration({
        ...canonicalBuilder(),
        files: ["package.json"],
      }),
    ).toThrow("canonical Desktop runtime FileSet is ambiguous");
  });

  it("requires an ad-hoc, teamless signature with bound metadata and sealed resources", () => {
    expect(() => verifyTelegramAcceptanceSignature(signature())).not.toThrow();
    for (const invalid of [
      signature({ Identifier: "icu.enduragent.desktop" }),
      signature({ Signature: "Developer ID Application: Production" }),
      signature({ TeamIdentifier: "ABCDE12345" }),
      signature({ InfoPlist: "Info.plist entries=0" }),
      signature({ SealedResources: "Sealed Resources version=2 rules=13 files=0" }),
      signature({ InternalRequirements: "Internal requirements count=0 size=0" }),
    ]) {
      expect(() => verifyTelegramAcceptanceSignature(invalid)).toThrow();
    }
  });

  it("requires the exact acceptance Info.plist identity", () => {
    expect(() => verifyTelegramAcceptanceInfoPlist(infoPlist())).not.toThrow();
    for (const [field, value] of [
      ["CFBundleIdentifier", "icu.enduragent.desktop"],
      ["CFBundleName", "Enduragent"],
      ["CFBundleDisplayName", "Enduragent"],
      ["CFBundleExecutable", "Enduragent"],
    ] as const) {
      expect(() => verifyTelegramAcceptanceInfoPlist({ ...infoPlist(), [field]: value })).toThrow(
        "Telegram acceptance Info.plist identity is invalid",
      );
    }
  });

  it("requires the exact signed entitlement dictionary", () => {
    expect(() =>
      verifyTelegramAcceptanceEntitlements(TELEGRAM_ACCEPTANCE_ENTITLEMENTS),
    ).not.toThrow();
    for (const invalid of [
      {},
      { "com.apple.security.cs.allow-jit": false },
      {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.disable-library-validation": true,
      },
      { "com.apple.application-identifier": TELEGRAM_ACCEPTANCE_APP_ID },
    ]) {
      expect(() => verifyTelegramAcceptanceEntitlements(invalid)).toThrow(
        "Telegram acceptance signed entitlements are invalid",
      );
    }
  });

  it("requires a teamless designated requirement for only the acceptance identifier", () => {
    const expected = `designated => identifier "${TELEGRAM_ACCEPTANCE_APP_ID}"`;
    expect(() => verifyTelegramAcceptanceDesignatedRequirement(expected)).not.toThrow();
    expect(() =>
      verifyTelegramAcceptanceDesignatedRequirement(`\n  ${expected.replaceAll(" ", "  ")}\n`),
    ).not.toThrow();
    for (const invalid of [
      'designated => identifier "icu.enduragent.desktop"',
      `${expected} and anchor apple`,
      `${expected} and certificate leaf[subject.OU] = ABCDE12345`,
      `identifier "${TELEGRAM_ACCEPTANCE_APP_ID}"`,
    ]) {
      expect(() => verifyTelegramAcceptanceDesignatedRequirement(invalid)).toThrow(
        "Telegram acceptance designated requirement is invalid",
      );
    }
  });

  it("requires the exact acceptance ASAR manifest identity and marker", () => {
    expect(() => verifyTelegramAcceptanceManifest(manifest(), version)).not.toThrow();
    for (const invalid of [
      { ...manifest(), name: "@enduragent/desktop" },
      { ...manifest(), productName: "Enduragent" },
      { ...manifest(), [TELEGRAM_ACCEPTANCE_MARKER]: false },
      { ...manifest(), version: "0.0.2" },
    ]) {
      expect(() => verifyTelegramAcceptanceManifest(invalid, version)).toThrow(
        "Telegram acceptance ASAR manifest identity is invalid",
      );
    }
  });
});
