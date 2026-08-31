import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createInteractiveDevelopmentPlan,
  DESKTOP_INSPECTION_FIXTURE_ENV,
  PLAN_CURRENT_INSPECTION_FIXTURE,
  selectInteractiveDevelopmentTemporaryRoot,
} from "../scripts/interactive-development.mjs";

const desktopRoot = join("/private", "tmp", "enduragent", "apps", "desktop");
const scratchRoot = join("/private", "tmp", "enduragent-desktop-development-fixture");
const nodeExecutable = join("/opt", "homebrew", "bin", "node");
const packageManagerScript = join("/private", "tmp", "corepack", "pnpm.cjs");

function plan(overrides: Partial<Parameters<typeof createInteractiveDevelopmentPlan>[0]> = {}) {
  return createInteractiveDevelopmentPlan({
    platform: "darwin",
    desktopRoot,
    scratchRoot,
    nodeExecutable,
    packageManagerScript,
    environment: {
      ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
      ELECTRON_CLI_ARGS: '["--user-data-dir=/shared/profile"]',
      SYNTHETIC: "preserved",
    },
    ...overrides,
  });
}

describe("interactive desktop development plan", () => {
  it("uses the short macOS temporary root required by local daemon sockets", () => {
    expect(selectInteractiveDevelopmentTemporaryRoot("darwin")).toBe("/tmp");
    expect(selectInteractiveDevelopmentTemporaryRoot("darwin", "/private/tmp/selected")).toBe(
      "/private/tmp/selected",
    );
  });

  it("pairs fresh athlete and Electron roots with visible temporary credentials", () => {
    const value = plan();

    expect(value).toEqual({
      command: "/usr/bin/caffeinate",
      args: ["-dimsu", nodeExecutable, packageManagerScript, "exec", "electron-vite", "dev"],
      cwd: desktopRoot,
      environment: {
        SYNTHETIC: "preserved",
        ENDURAGENT_HOME: join(scratchRoot, "athlete-home"),
        ENDURAGENT_DEVELOPMENT_USER_DATA: join(scratchRoot, "electron-user-data"),
        ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND: "memory",
        ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT: "1",
      },
      scratchRoot,
      athleteHome: join(scratchRoot, "athlete-home"),
      userData: join(scratchRoot, "electron-user-data"),
    });
    expect(value.athleteHome).not.toBe(value.userData);
  });

  it("launches the bounded Plan inspection fixture through the isolated command", () => {
    const value = plan({
      environment: {
        [DESKTOP_INSPECTION_FIXTURE_ENV]: PLAN_CURRENT_INSPECTION_FIXTURE,
        PLAN_QA_SCENARIO: "PL-S089",
        PLAN_QA_OUTCOME: "failure",
      },
    });

    expect(value.args).toEqual([
      "-dimsu",
      nodeExecutable,
      packageManagerScript,
      "exec",
      "tsx",
      "tests/helpers/plan-inspection-live.ts",
    ]);
    expect(value.environment[DESKTOP_INSPECTION_FIXTURE_ENV]).toBe(PLAN_CURRENT_INSPECTION_FIXTURE);
    expect(value.environment.PLAN_QA_SCENARIO).toBeUndefined();
    expect(value.environment.PLAN_QA_OUTCOME).toBeUndefined();
  });

  it("refuses an unknown inspection fixture", () => {
    expect(() =>
      plan({ environment: { [DESKTOP_INSPECTION_FIXTURE_ENV]: "arbitrary-script" } }),
    ).toThrow("unknown desktop inspection fixture");
  });

  it.each([
    ["a non-macOS platform", { platform: "linux" as const }],
    ["a relative desktop root", { desktopRoot: "apps/desktop" }],
    ["a relative scratch root", { scratchRoot: "scratch" }],
    ["a relative Node executable", { nodeExecutable: "node" }],
    ["a relative package manager script", { packageManagerScript: "pnpm.cjs" }],
  ])("refuses %s", (_label, override) => {
    expect(() => plan(override)).toThrow();
  });
});
