import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cleanupSecuritySmokeEnvironment,
  createElectronLaunchArguments,
  createSecuritySmokeEnvironment,
  createSecuritySmokeLaunchEnvironment,
} from "../smoke/security-smoke-environment.mjs";

const sourceEnvironment = {
  LLM_PROVIDER: "sentinel-llm-provider",
  ANTHROPIC_API_KEY: "sentinel-anthropic-api-key",
  OPENAI_API_KEY: "sentinel-openai-api-key",
  GOOGLE_GENERATIVE_AI_API_KEY: "sentinel-google-generative-ai-api-key",
  DEEPSEEK_API_KEY: "sentinel-deepseek-api-key",
  ALIBABA_API_KEY: "sentinel-alibaba-api-key",
  MINIMAX_API_KEY: "sentinel-minimax-api-key",
  MOONSHOT_API_KEY: "sentinel-moonshot-api-key",
  ZAI_API_KEY: "sentinel-zai-api-key",
  OPENROUTER_API_KEY: "sentinel-openrouter-api-key",
  LLM_API_KEY: "sentinel-llm-api-key",
  INTERVALS_API_KEY: "sentinel-intervals-api-key",
  TELEGRAM_BOT_TOKEN: "sentinel-telegram-bot-token",
  LLM_MODEL: "sentinel-llm-model",
  LLM_FLUSH_MODEL: "sentinel-llm-flush-model",
  LLM_COMPACT_MODEL: "sentinel-llm-compact-model",
  LLM_BASE_URL: "sentinel-llm-base-url",
  INTERVALS_ATHLETE_ID: "sentinel-intervals-athlete-id",
  HISTORY_TOKEN_BUDGET_RATIO: "sentinel-history-token-budget-ratio",
  SESSION_IDLE_MINUTES: "sentinel-session-idle-minutes",
  SESSION_DAILY_RESET_HOUR: "sentinel-session-daily-reset-hour",
  SESSION_RESET_ARCHIVE_RETENTION_DAYS: "sentinel-session-reset-archive-retention-days",
  COACH_TZ: "sentinel-coach-tz",
  CONTEXT_WINDOW_TOKENS: "sentinel-context-window-tokens",
  MY_LLM_KEY: "sentinel-my-llm-key",
  ELECTRON_RENDERER_URL: "sentinel-electron-renderer-url",
  NODE_OPTIONS: "sentinel-node-options",
  ELECTRON_RUN_AS_NODE: "sentinel-electron-run-as-node",
  LD_PRELOAD: "sentinel-ld-preload",
  DYLD_INSERT_LIBRARIES: "sentinel-dyld-insert-libraries",
  PATH: "sentinel-path",
  HTTP_PROXY: "sentinel-http-proxy",
  HTTPS_PROXY: "sentinel-https-proxy",
  ALL_PROXY: "sentinel-all-proxy",
  NO_PROXY: "sentinel-no-proxy",
  LANG: "sentinel-lang",
  LANGUAGE: "sentinel-language",
  LC_ALL: "sentinel-lc-all",
  HOME: "sentinel-home",
  ENDURAGENT_HOME: "sentinel-enduragent-home",
  CYCLING_COACH_HOME: "sentinel-cycling-coach-home",
  FORCE_COLOR: "sentinel-force-color",
  CLICOLOR_FORCE: "sentinel-clicolor-force",
  UNRELATED_VARIABLE: "sentinel-unrelated-variable",
  DISPLAY: "sentinel-display",
  WAYLAND_DISPLAY: "sentinel-wayland-display",
  XDG_SESSION_TYPE: "sentinel-xdg-session-type",
  XDG_RUNTIME_DIR: "sentinel-xdg-runtime-dir",
  DBUS_SESSION_BUS_ADDRESS: "sentinel-dbus-session-bus-address",
  XAUTHORITY: "sentinel-xauthority",
  SystemRoot: "sentinel-system-root",
  WINDIR: "sentinel-windir",
};

function isContained(root: string, path: string): boolean {
  const relation = relative(root, path);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("desktop security smoke environment", () => {
  it.each([
    ["darwin", {}],
    [
      "linux",
      {
        DISPLAY: sourceEnvironment.DISPLAY,
        WAYLAND_DISPLAY: sourceEnvironment.WAYLAND_DISPLAY,
        XDG_SESSION_TYPE: sourceEnvironment.XDG_SESSION_TYPE,
        XDG_RUNTIME_DIR: sourceEnvironment.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: sourceEnvironment.DBUS_SESSION_BUS_ADDRESS,
        XAUTHORITY: sourceEnvironment.XAUTHORITY,
      },
    ],
    [
      "win32",
      {
        SystemRoot: sourceEnvironment.SystemRoot,
        WINDIR: sourceEnvironment.WINDIR,
      },
    ],
  ] satisfies readonly [NodeJS.Platform, Record<string, string>][])(
    "builds the exact isolated launch environment on %s",
    (platform, inheritedEnvironment) => {
      const environment = createSecuritySmokeEnvironment("synthetic-scratch");

      expect(
        createSecuritySmokeLaunchEnvironment(sourceEnvironment, environment, platform),
      ).toEqual({
        ...inheritedEnvironment,
        HOME: environment.operatorHome,
        ENDURAGENT_HOME: environment.athleteHome,
        FORCE_COLOR: undefined,
        CLICOLOR_FORCE: undefined,
      });
    },
  );

  it("normalizes private paths and builds the exact launch arguments for both modes", () => {
    const scratchSpelling = join(".", "relative scratch=fixture", "nested path=component");
    const scratchRoot = resolve(scratchSpelling);
    const desktopRoot = join("desktop root=fixture", "nested app=component");
    const flag = "--desktop-security-smoke";
    const environment = createSecuritySmokeEnvironment(scratchSpelling);
    const privatePaths = [
      environment.scratchRoot,
      environment.athleteHome,
      environment.configDirectory,
      environment.operatorHome,
      environment.electronUserData,
      environment.screenshotDirectory,
      environment.screenshotPath,
    ];
    const expectedExtraArguments = [
      `--desktop-security-output=${join(scratchRoot, "desktop-security.png")}`,
      `--user-data-dir=${join(scratchRoot, "electron-user-data")}`,
    ];
    const developmentArguments = createElectronLaunchArguments(
      "development",
      desktopRoot,
      flag,
      environment.extraArguments,
    );
    const packagedArguments = createElectronLaunchArguments(
      "packaged",
      desktopRoot,
      flag,
      environment.extraArguments,
    );

    expect(isAbsolute(scratchSpelling)).toBe(false);
    expect(environment.scratchRoot).toBe(scratchRoot);
    expect(environment.extraArguments).toEqual(expectedExtraArguments);
    expect(developmentArguments).toEqual([desktopRoot, flag, ...expectedExtraArguments]);
    expect(packagedArguments).toEqual([flag, ...expectedExtraArguments]);
    for (const argumentsForMode of [developmentArguments, packagedArguments]) {
      expect(
        argumentsForMode.filter((argument) => argument.startsWith("--desktop-security-output=")),
      ).toHaveLength(1);
      expect(
        argumentsForMode.filter((argument) => argument.startsWith("--user-data-dir=")),
      ).toHaveLength(1);
    }
    expect(privatePaths.every((path) => isContained(scratchRoot, path))).toBe(true);
    expect(isContained(scratchRoot, `${scratchRoot}-decoy`)).toBe(false);
    expect(environment.launchEnvironment).toEqual({
      HOME: environment.operatorHome,
      ENDURAGENT_HOME: environment.athleteHome,
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
    });
  });

  it("removes only scratch while preserving a decoy and external output", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "desktop-security-cleanup-"));
    const scratchRoot = join(fixtureRoot, "scratch");
    const externalOutput = join(fixtureRoot, "external-output");
    const decoyVault = join(fixtureRoot, "operator-decoy", "vault");
    const environment = createSecuritySmokeEnvironment(scratchRoot, externalOutput);

    try {
      await Promise.all([
        mkdir(environment.electronUserData, { recursive: true }),
        mkdir(decoyVault, { recursive: true }),
        mkdir(externalOutput, { recursive: true }),
      ]);

      expect(environment.extraArguments[0]).toBe(
        `--desktop-security-output=${join(externalOutput, "desktop-security.png")}`,
      );
      expect(environment.outputDirectory).toBe(externalOutput);
      await cleanupSecuritySmokeEnvironment(environment);
      expect(await exists(environment.scratchRoot)).toBe(false);
      expect(await exists(environment.electronUserData)).toBe(false);
      expect(await exists(decoyVault)).toBe(true);
      expect(await exists(externalOutput)).toBe(true);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});
