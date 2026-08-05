import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const LINUX_LAUNCH_ENVIRONMENT_KEYS = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_SESSION_TYPE",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XAUTHORITY",
];
const WINDOWS_LAUNCH_ENVIRONMENT_KEYS = ["SystemRoot", "WINDIR"];

export function createElectronLaunchArguments(mode, desktopRoot, flag, extraArguments = []) {
  return mode === "packaged" ? [flag, ...extraArguments] : [desktopRoot, flag, ...extraArguments];
}

export function createSecuritySmokeEnvironment(scratchRoot, outputDirectory) {
  const normalizedScratchRoot = resolve(scratchRoot);
  const athleteHome = join(normalizedScratchRoot, "athlete-home");
  const configDirectory = join(athleteHome, "config");
  const operatorHome = join(normalizedScratchRoot, "operator-home");
  const electronUserData = join(normalizedScratchRoot, "electron-user-data");
  const screenshotDirectory = outputDirectory ?? normalizedScratchRoot;
  const screenshotPath = join(screenshotDirectory, "desktop-security.png");
  return {
    scratchRoot: normalizedScratchRoot,
    athleteHome,
    configDirectory,
    operatorHome,
    electronUserData,
    outputDirectory,
    screenshotDirectory,
    screenshotPath,
    launchEnvironment: {
      HOME: operatorHome,
      ENDURAGENT_HOME: athleteHome,
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
    },
    extraArguments: [
      `--desktop-security-output=${screenshotPath}`,
      `--user-data-dir=${electronUserData}`,
    ],
  };
}

export function createSecuritySmokeLaunchEnvironment(
  sourceEnvironment,
  securityEnvironment,
  platform,
) {
  const launchEnvironment = {};
  const inheritedKeys =
    platform === "linux"
      ? LINUX_LAUNCH_ENVIRONMENT_KEYS
      : platform === "win32"
        ? WINDOWS_LAUNCH_ENVIRONMENT_KEYS
        : [];

  for (const key of inheritedKeys) {
    const value = sourceEnvironment[key];
    if (value !== undefined) launchEnvironment[key] = value;
  }

  return { ...launchEnvironment, ...securityEnvironment.launchEnvironment };
}

export async function cleanupSecuritySmokeEnvironment(environment) {
  await rm(environment.scratchRoot, { recursive: true, force: true });
}
