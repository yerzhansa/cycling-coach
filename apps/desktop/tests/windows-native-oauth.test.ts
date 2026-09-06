import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertNativeOAuthHost,
  nativeOAuthEnvironment,
} from "../scripts/test-windows-native-oauth.js";

const hosted = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" };

describe("native OAuth acceptance boundaries", () => {
  it("refuses personal Windows hosts and emulated process architectures", () => {
    expect(() => assertNativeOAuthHost("win32", "x64", {})).toThrow();
    expect(() =>
      assertNativeOAuthHost("win32", "x64", { ...hosted, RUNNER_ENVIRONMENT: "self-hosted" }),
    ).toThrow();
    expect(() => assertNativeOAuthHost("win32", "arm64", hosted)).toThrow();
    expect(() => assertNativeOAuthHost("darwin", "x64", hosted)).toThrow();
    expect(() => assertNativeOAuthHost("win32", "x64", hosted)).not.toThrow();
  });

  it("cannot inherit a simulated crypto backend, debugger preload, or personal credential home", () => {
    const isolated = nativeOAuthEnvironment("scratch", {
      ...hosted,
      SystemRoot: "Windows",
      PATH: "system-path",
      ENDURAGENT_HOME: "personal-athlete-home",
      LOCALAPPDATA: "personal-local-data",
      APPDATA: "personal-roaming-data",
      USERPROFILE: "personal-profile",
      NODE_OPTIONS: "--import injected-loader",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_RENDERER_URL: "http://external-renderer",
      ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "file",
      ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: "1",
      ENDURAGENT_ACCEPTANCE_OAUTH_ORIGIN: "http://synthetic-provider",
      OPENAI_API_KEY: "synthetic-provider-secret",
    });
    expect(isolated.ENDURAGENT_HOME).toBe(join("scratch", "athlete"));
    expect(isolated.LOCALAPPDATA).toBe(join("scratch", "local"));
    expect(isolated.APPDATA).toBe(join("scratch", "roaming"));
    expect(isolated.USERPROFILE).toBe(join("scratch", "profile"));
    expect(isolated.PATH).toBe("system-path");
    for (const key of [
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
      "ELECTRON_RENDERER_URL",
      "ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND",
      "ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT",
      "ENDURAGENT_ACCEPTANCE_OAUTH_ORIGIN",
      "OPENAI_API_KEY",
    ])
      expect(isolated).not.toHaveProperty(key);
  });
});
