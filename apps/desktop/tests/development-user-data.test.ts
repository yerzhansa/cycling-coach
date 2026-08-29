import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEVELOPMENT_USER_DATA_ENV,
  bindDevelopmentUserData,
  decideDevelopmentUserDataBinding,
} from "../src/main/development-user-data.js";

const path = join("/private", "tmp", "enduragent-development", "electron-user-data");
const authorizedEnvironment = {
  [DEVELOPMENT_USER_DATA_ENV]: path,
  ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "memory",
  ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: "1",
};

describe("isolated development user data binding", () => {
  it("binds a visible unpackaged macOS app to the authorized disposable profile", () => {
    expect(
      decideDevelopmentUserDataBinding({
        platform: "darwin",
        isPackaged: false,
        environment: authorizedEnvironment,
      }),
    ).toEqual({ kind: "bind", path });

    const setPath = vi.fn();
    expect(
      bindDevelopmentUserData(
        { setPath },
        {
          platform: "darwin",
          isPackaged: false,
          environment: authorizedEnvironment,
        },
      ),
    ).toEqual({ kind: "bind", path });
    expect(setPath).toHaveBeenCalledOnce();
    expect(setPath).toHaveBeenCalledWith("userData", path);
  });

  it("does nothing when the isolated launcher did not request a profile", () => {
    const setPath = vi.fn();
    expect(
      bindDevelopmentUserData(
        { setPath },
        {
          platform: "darwin",
          isPackaged: false,
          environment: {},
        },
      ),
    ).toEqual({ kind: "no-op" });
    expect(setPath).not.toHaveBeenCalled();
  });

  it.each([
    ["a packaged app", { isPackaged: true }],
    ["a non-macOS app", { platform: "linux" as const }],
    [
      "a persistent credential context",
      {
        environment: {
          ...authorizedEnvironment,
          ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: undefined,
        },
      },
    ],
    [
      "a non-memory credential backend",
      {
        environment: {
          ...authorizedEnvironment,
          ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "file",
        },
      },
    ],
    [
      "a relative profile path",
      {
        environment: { ...authorizedEnvironment, [DEVELOPMENT_USER_DATA_ENV]: "relative/profile" },
      },
    ],
  ])("refuses %s", (_label, override) => {
    expect(() =>
      decideDevelopmentUserDataBinding({
        platform: "darwin",
        isPackaged: false,
        environment: authorizedEnvironment,
        ...override,
      }),
    ).toThrow("isolated development user data binding refused");
  });
});
