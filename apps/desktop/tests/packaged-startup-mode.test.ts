import { describe, expect, it, vi } from "vitest";
import {
  ACCEPTANCE_OS_LOGIN_MARKER_ENV,
  ACCEPTANCE_OS_LOGIN_MARKER_VALUE,
  consumeAcceptanceStartupMarker,
  type AcceptanceLoginLaunchPort,
} from "../scripts/support/packaged-telegram/startup-mode.js";

function loginPort(wasOpenedAtLogin = false) {
  const getLoginItemSettings = vi.fn(() => ({
    openAtLogin: false,
    executableWillLaunchAtLogin: false,
    wasOpenedAtLogin,
    status: "not-registered" as const,
  }));
  const prototype = { getLoginItemSettings };
  const app = Object.create(prototype) as AcceptanceLoginLaunchPort;
  return { app, getLoginItemSettings };
}

describe("packaged startup-mode adapter", () => {
  it("consumes an exact marker and injects one OS-login observation", () => {
    const environment: NodeJS.ProcessEnv = {
      [ACCEPTANCE_OS_LOGIN_MARKER_ENV]: ACCEPTANCE_OS_LOGIN_MARKER_VALUE,
    };
    const { app, getLoginItemSettings } = loginPort();

    expect(consumeAcceptanceStartupMarker(environment, app)).toBe("os-login");
    expect(environment).not.toHaveProperty(ACCEPTANCE_OS_LOGIN_MARKER_ENV);
    expect(app.getLoginItemSettings()).toMatchObject({ wasOpenedAtLogin: true });
    expect(app.getLoginItemSettings()).toMatchObject({ wasOpenedAtLogin: false });
    expect(getLoginItemSettings).toHaveBeenCalledTimes(2);
  });

  it("injects one manual observation for an unmarked acceptance launch", () => {
    const environment: NodeJS.ProcessEnv = {};
    const { app, getLoginItemSettings } = loginPort(true);

    expect(consumeAcceptanceStartupMarker(environment, app)).toBe("manual");
    expect(app.getLoginItemSettings()).toMatchObject({ wasOpenedAtLogin: false });
    expect(app.getLoginItemSettings()).toMatchObject({ wasOpenedAtLogin: true });
    expect(getLoginItemSettings).toHaveBeenCalledTimes(2);
  });

  it("deletes and rejects every non-exact marker", () => {
    const environment: NodeJS.ProcessEnv = {
      [ACCEPTANCE_OS_LOGIN_MARKER_ENV]: "true",
    };
    const { app, getLoginItemSettings } = loginPort();

    expect(() => consumeAcceptanceStartupMarker(environment, app)).toThrow(
      "Telegram acceptance startup marker is invalid",
    );
    expect(environment).not.toHaveProperty(ACCEPTANCE_OS_LOGIN_MARKER_ENV);
    expect(getLoginItemSettings).not.toHaveBeenCalled();
  });
});
