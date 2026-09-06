import { describe, expect, it, vi } from "vitest";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import {
  UnsupportedLaunchdPlatformError,
  type LaunchdServiceStatus,
} from "@enduragent/kernel-node/service";
import { readDesktopRegistration } from "../src/desktop-registration.js";

const home: AthleteHome = {
  root: "/tmp/synthetic-athlete",
  storeDir: "/tmp/synthetic-athlete/store",
  archiveDir: "/tmp/synthetic-athlete/archive",
  configDir: "/tmp/synthetic-athlete/config",
};

const status: LaunchdServiceStatus = {
  kind: "registered",
  registered: true,
  installed: true,
  loaded: true,
  running: true,
  label: "ai.enduragent.coach.synthetic",
  pid: 91,
  lastExitStatus: null,
  paths: {
    launchAgentsDir: "/tmp/LaunchAgents",
    plistPath: "/tmp/LaunchAgents/ai.enduragent.coach.synthetic.plist",
    stateDir: "/tmp/synthetic-athlete/config/service",
    envPath: "/tmp/synthetic-athlete/config/service/service.env",
    wrapperPath: "/tmp/synthetic-athlete/config/service/service.sh",
    handoffPath: "/tmp/synthetic-athlete/config/service/service.handoff",
  },
};

describe("desktop registration", () => {
  it("delegates Darwin observation and preserves the exact launchd result", async () => {
    const readServiceStatus = vi.fn(async () => status);

    const result = await readDesktopRegistration(
      { platform: "darwin", home, executablePath: "/tmp/enduragent" },
      { readServiceStatus },
    );

    expect(result).toEqual({ source: "launchd", registration: "present", status });
    if (result.source === "launchd") expect(result.status).toBe(status);
    expect(readServiceStatus).toHaveBeenCalledOnce();
    expect(readServiceStatus).toHaveBeenCalledWith({
      home,
      executablePath: "/tmp/enduragent",
    });
  });

  it("classifies Windows as absent without invoking any launchd-shaped observer", async () => {
    const readServiceStatus = vi.fn(async () => status);
    const serviceRegistrationState = vi.fn(async () => "present" as const);

    await expect(
      readDesktopRegistration(
        { platform: "win32", home, executablePath: "C:\\Enduragent\\enduragent.exe" },
        { readServiceStatus, serviceRegistrationState },
      ),
    ).resolves.toEqual({ source: "app-supervised", registration: "absent" });
    expect(readServiceStatus).not.toHaveBeenCalled();
    expect(serviceRegistrationState).not.toHaveBeenCalled();
  });

  it("classifies Linux as absent without invoking any launchd-shaped observer", async () => {
    const readServiceStatus = vi.fn(async () => {
      throw new UnsupportedLaunchdPlatformError();
    });

    await expect(
      readDesktopRegistration(
        { platform: "linux", home, executablePath: "/tmp/enduragent" },
        { readServiceStatus },
      ),
    ).resolves.toEqual({ source: "app-supervised", registration: "absent" });
    expect(readServiceStatus).not.toHaveBeenCalled();
  });

  it("honors an explicit registration override on Linux", async () => {
    const readServiceStatus = vi.fn(async () => status);
    const serviceRegistrationState = vi.fn(async () => "unknown" as const);

    await expect(
      readDesktopRegistration(
        { platform: "linux", home, executablePath: "/tmp/enduragent" },
        { readServiceStatus, serviceRegistrationState },
      ),
    ).resolves.toEqual({ source: "override", registration: "unknown" });
    expect(readServiceStatus).not.toHaveBeenCalled();
    expect(serviceRegistrationState).toHaveBeenCalledOnce();
  });
});
