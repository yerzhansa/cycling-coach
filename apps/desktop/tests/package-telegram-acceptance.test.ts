import { describe, expect, it } from "vitest";
import {
  createTelegramAcceptanceBuilderConfiguration,
  selectTelegramAcceptanceNestedTarget,
  TELEGRAM_ACCEPTANCE_APP_ID,
  TELEGRAM_ACCEPTANCE_ENTITLEMENTS,
  TELEGRAM_ACCEPTANCE_MARKER,
  TELEGRAM_ACCEPTANCE_PACKAGE_NAME,
  TELEGRAM_ACCEPTANCE_PRODUCT_NAME,
  verifyTelegramAcceptanceDesignatedRequirement,
  verifyTelegramAcceptanceEntitlements,
  verifyTelegramAcceptanceInfoPlist,
  verifyTelegramAcceptanceMainEntry,
  verifyTelegramAcceptanceManifest,
  verifyTelegramAcceptanceNestedEntitlements,
  verifyTelegramAcceptanceNestedListing,
  verifyTelegramAcceptanceNestedSignature,
  verifyTelegramAcceptanceSignature,
} from "./fixtures/packaged-telegram/package-acceptance.mjs";

const version = "0.0.1";
const cdHash = "0123456789abcdef0123456789abcdef01234567";

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
    `CDHash=${overrides.CDHash ?? cdHash}`,
  ].join("\n");
}

function nestedSignature(overrides: Partial<Record<string, string>> = {}): string {
  return [
    `Executable=${overrides.Executable ?? "/Applications/Acceptance.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper"}`,
    `Identifier=${overrides.Identifier ?? "icu.enduragent.desktop.telegram-acceptance.helper"}`,
    `CDHash=${overrides.CDHash ?? cdHash}`,
    `Signature=${overrides.Signature ?? "adhoc"}`,
    `TeamIdentifier=${overrides.TeamIdentifier ?? "not set"}`,
    ...(overrides.Nested === undefined ? [] : [overrides.Nested]),
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
    type: "module",
    main: "out/main/index.js",
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
    expect(verifyTelegramAcceptanceSignature(signature())).toBe(cdHash);
    for (const invalid of [
      signature({ Identifier: "icu.enduragent.desktop" }),
      signature({ Signature: "Developer ID Application: Production" }),
      signature({ TeamIdentifier: "ABCDE12345" }),
      signature({ InfoPlist: "Info.plist entries=0" }),
      signature({ SealedResources: "Sealed Resources version=2 rules=13 files=0" }),
      signature({ InternalRequirements: "Internal requirements count=0 size=0" }),
      signature({ CDHash: "not-a-cdhash" }),
      `${signature()}\nSignature=Developer ID Application: Production`,
      `${signature()}\nTeamIdentifier=not set`,
    ]) {
      expect(() => verifyTelegramAcceptanceSignature(invalid)).toThrow();
    }
  });

  it("requires every nested code object to be unambiguously ad-hoc and teamless", () => {
    expect(() => verifyTelegramAcceptanceNestedSignature(nestedSignature())).not.toThrow();
    for (const invalid of [
      nestedSignature({ Signature: "Developer ID Application: Production" }),
      nestedSignature({ TeamIdentifier: "ABCDE12345" }),
      nestedSignature({ CDHash: "not-a-cdhash" }),
      `${nestedSignature()}\nSignature=adhoc`,
      `${nestedSignature()}\nTeamIdentifier=not set`,
    ]) {
      expect(() => verifyTelegramAcceptanceNestedSignature(invalid)).toThrow(
        "Telegram acceptance nested signature is invalid",
      );
    }
  });

  it("accepts absent nested entitlements or only the allow-jit entitlement", () => {
    expect(() => verifyTelegramAcceptanceNestedEntitlements(undefined)).not.toThrow();
    expect(() =>
      verifyTelegramAcceptanceNestedEntitlements(TELEGRAM_ACCEPTANCE_ENTITLEMENTS),
    ).not.toThrow();
    for (const invalid of [
      null,
      {},
      { "com.apple.security.cs.allow-jit": false },
      {
        "com.apple.security.cs.allow-jit": true,
        "com.apple.security.cs.disable-library-validation": true,
      },
    ]) {
      expect(() => verifyTelegramAcceptanceNestedEntitlements(invalid)).toThrow(
        "Telegram acceptance nested entitlements are invalid",
      );
    }
  });

  it("enumerates only unique, relative nested code paths from one executable", () => {
    const description = [
      nestedSignature(),
      "Nested=Frameworks/Helper.app",
      "Nested=Frameworks/Electron Framework.framework",
    ].join("\n");
    expect(verifyTelegramAcceptanceNestedListing(description)).toEqual({
      executable:
        "/Applications/Acceptance.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper",
      nested: ["Frameworks/Helper.app", "Frameworks/Electron Framework.framework"],
    });

    for (const nested of [
      "Nested=",
      "Nested=/tmp/escape",
      "Nested=../escape",
      "Nested=Frameworks/../escape",
      "Nested=Frameworks/./Helper.app",
      "Nested=Frameworks//Helper.app",
      "Nested=Frameworks\\Helper.app",
      "Nested=Frameworks/Helper.app\nNested=Frameworks/Helper.app",
    ]) {
      expect(() =>
        verifyTelegramAcceptanceNestedListing([nestedSignature(), nested].join("\n")),
      ).toThrow("Telegram acceptance nested code listing is invalid");
    }
    expect(() =>
      verifyTelegramAcceptanceNestedListing(
        `${nestedSignature()}\nExecutable=/Applications/Other.app/Contents/MacOS/Other`,
      ),
    ).toThrow("Telegram acceptance nested code listing is invalid");
  });

  it("selects one canonical nested target inside the application", () => {
    const application = "/Applications/Acceptance.app";
    const helper = `${application}/Contents/Frameworks/Helper.app`;
    expect(selectTelegramAcceptanceNestedTarget(application, [helper, helper])).toBe(helper);
    expect(() => selectTelegramAcceptanceNestedTarget(application, [])).toThrow(
      "Telegram acceptance nested code target is missing",
    );
    expect(() =>
      selectTelegramAcceptanceNestedTarget(application, [
        helper,
        `${application}/Contents/Frameworks/Other.framework`,
      ]),
    ).toThrow("Telegram acceptance nested code target is ambiguous");
    expect(() => selectTelegramAcceptanceNestedTarget(application, ["/tmp/escape"])).toThrow(
      "Telegram acceptance nested code target escapes the application",
    );
    expect(() =>
      selectTelegramAcceptanceNestedTarget(application, ["relative/Helper.app"]),
    ).toThrow("Telegram acceptance nested code resolution is invalid");
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

  it("binds the ad-hoc designated requirement to the verified code-directory hash", () => {
    const expected = `# designated => cdhash H"${cdHash}"`;
    expect(() => verifyTelegramAcceptanceDesignatedRequirement(expected, cdHash)).not.toThrow();
    expect(() =>
      verifyTelegramAcceptanceDesignatedRequirement(
        `\n  ${expected.replaceAll(" ", "  ")}\n`,
        cdHash,
      ),
    ).not.toThrow();
    for (const invalid of [
      `designated => cdhash H"${cdHash}"`,
      `# designated => cdhash H"1123456789abcdef0123456789abcdef01234567"`,
      `# designated => identifier "${TELEGRAM_ACCEPTANCE_APP_ID}"`,
      `${expected} and anchor apple`,
      `# designated => cdhash h"${cdHash}"`,
    ]) {
      expect(() => verifyTelegramAcceptanceDesignatedRequirement(invalid, cdHash)).toThrow(
        "Telegram acceptance designated requirement is invalid",
      );
    }
    expect(() => verifyTelegramAcceptanceDesignatedRequirement(expected, "not-a-cdhash")).toThrow(
      "Telegram acceptance code-directory hash is invalid",
    );
  });

  it("requires the exact acceptance ASAR manifest identity and marker", () => {
    expect(() => verifyTelegramAcceptanceManifest(manifest(), version)).not.toThrow();
    for (const invalid of [
      { ...manifest(), name: "@enduragent/desktop" },
      { ...manifest(), productName: "Enduragent" },
      { ...manifest(), [TELEGRAM_ACCEPTANCE_MARKER]: false },
      { ...manifest(), version: "0.0.2" },
      { ...manifest(), type: "commonjs" },
      { ...manifest(), main: "out/main/not-the-wrapper.js" },
    ]) {
      expect(() => verifyTelegramAcceptanceManifest(invalid, version)).toThrow(
        "Telegram acceptance ASAR manifest identity is invalid",
      );
    }
  });

  it("keeps the wrapped production main beside its runtime-relative dependencies", () => {
    expect(verifyTelegramAcceptanceMainEntry('await import("./index-DV6OlGhL.js");')).toBe(
      "out/main/index-DV6OlGhL.js",
    );
    for (const invalid of [
      'await import("./chunks/index-DV6OlGhL.js");',
      'await import("../main/index-DV6OlGhL.js");',
      'await import("./index.js");',
      'await import("./index-first.js"); await import("./index-second.js");',
      '// await import("./index-does-not-exist.js");',
      '/*\nawait import("./index-does-not-exist.js");',
      'const source = `\nawait import("./index-does-not-exist.js");',
      'await import("./index-DV6OlGhL.js");\nprocess.stdout.write("after handoff");',
      undefined,
    ]) {
      expect(() => verifyTelegramAcceptanceMainEntry(invalid)).toThrow();
    }
  });
});
