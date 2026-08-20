import { describe, expect, it } from "vitest";
import {
  KEYCHAIN_HELPER_DEVELOPMENT_DIRECTORY,
  KEYCHAIN_HELPER_EXECUTABLE_NAME,
  KEYCHAIN_HELPER_RESOURCE_DIRECTORY,
  resolveKeychainHelperPath,
} from "../src/main/keychain-helper-path.js";

const packaged = {
  platform: "darwin" as NodeJS.Platform,
  packaged: true,
  resourcesPath: "/Applications/Enduragent.app/Contents/Resources",
  applicationPath: "/Applications/Enduragent.app/Contents/Resources/app.asar",
};

const development = {
  platform: "darwin" as NodeJS.Platform,
  packaged: false,
  resourcesPath: "/opt/electron/resources",
  applicationPath: "/repository/apps/desktop",
};

describe("keychain helper path", () => {
  it("resolves the packaged helper under the external resource directory", () => {
    expect(resolveKeychainHelperPath(packaged)).toBe(
      `/Applications/Enduragent.app/Contents/Resources/${KEYCHAIN_HELPER_RESOURCE_DIRECTORY}/${KEYCHAIN_HELPER_EXECUTABLE_NAME}`,
    );
  });

  it("resolves the locally compiled helper in development", () => {
    expect(resolveKeychainHelperPath(development)).toBe(
      `/repository/apps/desktop/${KEYCHAIN_HELPER_DEVELOPMENT_DIRECTORY}/${KEYCHAIN_HELPER_EXECUTABLE_NAME}`,
    );
  });

  it.each(["win32", "linux"] as const)("returns nothing on %s", (platform) => {
    expect(resolveKeychainHelperPath({ ...packaged, platform })).toBeUndefined();
    expect(resolveKeychainHelperPath({ ...development, platform })).toBeUndefined();
  });

  it("returns nothing when the resolved root is not absolute", () => {
    expect(resolveKeychainHelperPath({ ...packaged, resourcesPath: "Resources" })).toBeUndefined();
    expect(
      resolveKeychainHelperPath({ ...development, applicationPath: "apps/desktop" }),
    ).toBeUndefined();
  });

  it("ignores the unused sibling root for each mode", () => {
    expect(resolveKeychainHelperPath({ ...packaged, applicationPath: "relative" })).toBe(
      `/Applications/Enduragent.app/Contents/Resources/${KEYCHAIN_HELPER_RESOURCE_DIRECTORY}/${KEYCHAIN_HELPER_EXECUTABLE_NAME}`,
    );
    expect(resolveKeychainHelperPath({ ...development, resourcesPath: "relative" })).toBe(
      `/repository/apps/desktop/${KEYCHAIN_HELPER_DEVELOPMENT_DIRECTORY}/${KEYCHAIN_HELPER_EXECUTABLE_NAME}`,
    );
  });
});
