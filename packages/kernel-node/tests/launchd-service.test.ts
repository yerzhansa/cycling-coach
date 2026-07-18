import { execFile as nodeExecFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AthleteHome } from "@enduragent/kernel-node/home";

import {
  LAUNCHD_ENV_MODE,
  LAUNCHD_PLIST_MODE,
  LAUNCHD_STATE_DIR_MODE,
  LAUNCHD_WRAPPER_MODE,
  LaunchdServiceCommandError,
  LaunchdServiceNotInstalledError,
  UnsupportedLaunchdPlatformError,
  buildLaunchdServicePlist,
  canonicalizeAthleteHome,
  createLaunchdServiceIdentity,
  deriveLaunchdServiceLabel,
  installLaunchdService,
  readLaunchdServiceStatus,
  resolveLaunchdServicePaths,
  restartLaunchdService,
  restartLaunchdServiceForUpgrade,
  resumeLaunchdService,
  resumeLaunchdServiceAfterEphemeral,
  uninstallLaunchdService,
  type LaunchdCommandResult,
  type LaunchdServiceDependencies,
  type LaunchdServiceIdentity,
} from "../src/service/index.js";

const execFile = promisify(nodeExecFile);
const roots: string[] = [];
const capability = "abcdefghijklmnopqrstuvwxyzABCDEFGH012345678";

async function scratch(prefix = "launchd-service-"): Promise<string> {
  const systemTemporaryDirectory = await realpath(tmpdir());
  const root = await mkdtemp(join(systemTemporaryDirectory, prefix));
  roots.push(root);
  return root;
}

function athleteHome(root: string): AthleteHome {
  return Object.freeze({
    root,
    storeDir: join(root, "store"),
    archiveDir: join(root, "archive"),
    configDir: join(root, "config"),
  });
}

async function fixture(label = "ai.enduragent.coach.synthetic"): Promise<{
  root: string;
  userHome: string;
  identity: LaunchdServiceIdentity;
  dependencies: LaunchdServiceDependencies;
}> {
  const root = await scratch();
  const userHome = join(root, "user");
  const home = athleteHome(join(root, "athlete"));
  const identity = createLaunchdServiceIdentity({
    home,
    executablePath: join(root, "bin", "enduragent"),
    label,
  });
  return {
    root,
    userHome,
    identity,
    dependencies: { platform: "darwin", uid: 501, userHome },
  };
}

function exited(exitCode = 0, stdout = "", stderr = ""): LaunchdCommandResult {
  return { outcome: "exited", exitCode, stdout, stderr };
}

function notFound(): LaunchdCommandResult {
  return exited(113, "", "Could not find service");
}

function mode(value: Awaited<ReturnType<typeof stat>>): number {
  return Number(value.mode) & 0o777;
}

interface FakeLaunchctl {
  readonly calls: string[][];
  readonly run: NonNullable<LaunchdServiceDependencies["runLaunchctl"]>;
  loaded: boolean;
  running: boolean;
}

function fakeLaunchctl(
  initial: {
    loaded?: boolean;
    running?: boolean;
  } = {},
): FakeLaunchctl {
  const fake: FakeLaunchctl = {
    calls: [],
    loaded: initial.loaded ?? false,
    running: initial.running ?? false,
    async run(args) {
      fake.calls.push([...args]);
      if (args[0] === "print") {
        if (!fake.loaded) return notFound();
        return exited(
          0,
          fake.running
            ? "state = running\npid = 321\nlast exit status = 7\n"
            : "state = exited\nlast exit status = 0\n",
        );
      }
      if (args[0] === "bootout") {
        const wasLoaded = fake.loaded;
        fake.loaded = false;
        fake.running = false;
        return wasLoaded ? exited() : notFound();
      }
      if (args[0] === "bootstrap") {
        fake.loaded = true;
        fake.running = false;
      }
      if (args[0] === "kickstart") {
        fake.loaded = true;
        fake.running = true;
      }
      return exited();
    },
  };
  return fake;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("launchd service identity and bytes", () => {
  it("renders the literal escaped plist with failure-only KeepAlive", () => {
    const identity = {
      label: `label&<>"'`,
      executablePath: `/tmp/exe&<>"'`,
      home: athleteHome("/tmp/athlete"),
    };
    const paths = {
      launchAgentsDir: "/tmp/LaunchAgents",
      plistPath: "/tmp/LaunchAgents/service.plist",
      stateDir: "/tmp/state",
      envPath: `/tmp/state/env&<>"'`,
      wrapperPath: `/tmp/state/wrapper&<>"'`,
      handoffPath: "/tmp/state/service.handoff",
    };

    expect(buildLaunchdServicePlist(identity, paths)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>label&amp;&lt;&gt;&quot;&apos;</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/sh</string>
      <string>/tmp/state/wrapper&amp;&lt;&gt;&quot;&apos;</string>
      <string>/tmp/state/env&amp;&lt;&gt;&quot;&apos;</string>
      <string>/tmp/exe&amp;&lt;&gt;&quot;&apos;</string>
      <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>10</integer>
  </dict>
</plist>
`);
  });

  it("contains no forbidden launch activation or secret-bearing keys", async () => {
    const { identity, dependencies } = await fixture();
    const plist = buildLaunchdServicePlist(
      identity,
      resolveLaunchdServicePaths(identity, dependencies),
    );
    expect(plist).toContain("<string>serve</string>");
    expect(plist).not.toMatch(
      /PathState|Sockets|MachServices|EnvironmentVariables|token|port|lock/i,
    );
  });

  it("derives stable opaque labels from normalized roots", () => {
    const expected = createHash("sha256")
      .update(resolve("relative-athlete"), "utf8")
      .digest("hex")
      .slice(0, 16);
    expect(deriveLaunchdServiceLabel("relative-athlete")).toBe(`ai.enduragent.coach.${expected}`);
    expect(deriveLaunchdServiceLabel("relative-athlete")).not.toBe(
      deriveLaunchdServiceLabel("other-athlete"),
    );
  });

  it("canonicalizes all home paths together and rejects incoherent children", () => {
    const canonical = canonicalizeAthleteHome({
      root: "relative-athlete",
      storeDir: "relative-athlete/store",
      archiveDir: "relative-athlete/archive",
      configDir: "relative-athlete/config",
    });
    expect(canonical).toEqual(athleteHome(resolve("relative-athlete")));
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(() =>
      canonicalizeAthleteHome({
        ...canonical,
        configDir: resolve("somewhere-else"),
      }),
    ).toThrow(TypeError);
  });

  it("preserves the canonical home object and rejects invalid identity inputs", () => {
    const home = athleteHome("/tmp/athlete");
    const identity = createLaunchdServiceIdentity({
      home,
      executablePath: "/tmp/../tmp/enduragent",
    });
    expect(identity.home).toBe(home);
    expect(identity.executablePath).toBe("/tmp/enduragent");
    expect(Object.isFrozen(identity)).toBe(true);
    expect(() =>
      createLaunchdServiceIdentity({
        home,
        executablePath: "relative",
      }),
    ).toThrow(TypeError);
    expect(() =>
      createLaunchdServiceIdentity({
        home,
        executablePath: "/tmp/enduragent",
        label: "invalid label",
      }),
    ).toThrow(TypeError);
  });
});

describe("launchd installation and wrapper", () => {
  it("installs exact bytes and modes and converges across lifecycle repeats", async () => {
    const { identity, dependencies } = await fixture();
    const fake = fakeLaunchctl();
    const injected = { ...dependencies, runLaunchctl: fake.run };
    const first = await installLaunchdService(identity, injected);
    const paths = first.paths;
    const firstBytes = {
      env: await readFile(paths.envPath, "utf8"),
      wrapper: await readFile(paths.wrapperPath, "utf8"),
      plist: await readFile(paths.plistPath, "utf8"),
    };
    expect(first.loaded).toBe(true);
    expect(firstBytes.env).toBe(
      `export ENDURAGENT_HOME='${identity.home.root}'\nexport ENDURAGENT_DAEMON_OWNER='service-managed'\n`,
    );
    expect(firstBytes.plist).toBe(buildLaunchdServicePlist(identity, paths));
    expect(mode(await stat(paths.plistPath))).toBe(LAUNCHD_PLIST_MODE);
    expect(mode(await stat(paths.stateDir))).toBe(LAUNCHD_STATE_DIR_MODE);
    expect(mode(await stat(paths.envPath))).toBe(LAUNCHD_ENV_MODE);
    expect(mode(await stat(paths.wrapperPath))).toBe(LAUNCHD_WRAPPER_MODE);

    await installLaunchdService(identity, injected);
    expect(await readFile(paths.envPath, "utf8")).toBe(firstBytes.env);
    expect(await readFile(paths.wrapperPath, "utf8")).toBe(firstBytes.wrapper);
    expect(await readFile(paths.plistPath, "utf8")).toBe(firstBytes.plist);
    expect(fake.calls.map((call) => call[0])).toEqual([
      "bootout",
      "enable",
      "bootstrap",
      "print",
      "bootout",
      "enable",
      "bootstrap",
      "print",
    ]);

    await uninstallLaunchdService(identity, injected);
    await uninstallLaunchdService(identity, injected);
    const reinstalled = await installLaunchdService(identity, injected);
    expect(await readFile(reinstalled.paths.plistPath, "utf8")).toBe(firstBytes.plist);
    expect(mode(await stat(reinstalled.paths.plistPath))).toBe(0o600);
  });

  it("executes absolute paths under a minimal PATH with quoted home bytes", async () => {
    const root = await scratch();
    const userHome = join(root, "user");
    const home = athleteHome(join(root, "athlete's home"));
    const executablePath = join(root, "bin space", "synthetic executable");
    const outputPath = join(root, "observed");
    await mkdir(join(root, "bin space"), { recursive: true });
    await writeFile(
      executablePath,
      `#!/bin/sh\n/usr/bin/printf '%s\\n%s\\n%s\\n' "$ENDURAGENT_HOME" "$ENDURAGENT_DAEMON_OWNER" "$1" > '${outputPath}'\n`,
      { mode: 0o700 },
    );
    const identity = createLaunchdServiceIdentity({
      home,
      executablePath,
      label: "ai.enduragent.coach.wrapper",
    });
    const fake = fakeLaunchctl();
    const installed = await installLaunchdService(identity, {
      platform: "darwin",
      uid: 501,
      userHome,
      runLaunchctl: fake.run,
    });
    await execFile(
      "/bin/sh",
      [installed.paths.wrapperPath, installed.paths.envPath, identity.executablePath, "serve"],
      { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
    );
    expect(await readFile(outputPath, "utf8")).toBe(`${home.root}\nservice-managed\nserve\n`);
  });

  it("delivers a one-use protected handoff and leaves no replay carrier", async () => {
    const { root, identity, dependencies } = await fixture();
    const outputPath = join(root, "handoff-observed");
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(
      identity.executablePath,
      `#!/bin/sh\n/usr/bin/printf '%s\\n%s\\n%s\\n' "$ENDURAGENT_DAEMON_OWNER" "$ENDURAGENT_HANDOFF_CAPABILITY" "$1" > '${outputPath}'\n`,
      { mode: 0o700 },
    );
    const fake = fakeLaunchctl();
    const injected = { ...dependencies, runLaunchctl: fake.run };
    const installed = await installLaunchdService(identity, injected);
    await restartLaunchdServiceForUpgrade(
      identity,
      { targetProtocolVersion: 1, handoffCapability: capability },
      injected,
    );
    expect(mode(await stat(installed.paths.handoffPath))).toBe(0o600);
    expect(await readFile(installed.paths.handoffPath, "utf8")).toBe(`${capability}\n`);
    expect(await readFile(installed.paths.plistPath, "utf8")).not.toContain(capability);
    expect(fake.calls.flat().join(" ")).not.toContain(capability);

    await execFile("/bin/sh", [
      installed.paths.wrapperPath,
      installed.paths.envPath,
      identity.executablePath,
      "serve",
    ]);
    expect(await readFile(outputPath, "utf8")).toBe(`service-managed\n${capability}\nserve\n`);
    await expect(lstat(installed.paths.handoffPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await execFile("/bin/sh", [
      installed.paths.wrapperPath,
      installed.paths.envPath,
      identity.executablePath,
      "serve",
    ]);
    expect(await readFile(outputPath, "utf8")).toBe("service-managed\n\nserve\n");
  });

  it("rejects malformed, multi-line, loose-mode, and symlink handoffs", async () => {
    const { root, identity, dependencies } = await fixture();
    const executablePath = identity.executablePath;
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const fake = fakeLaunchctl();
    const installed = await installLaunchdService(identity, {
      ...dependencies,
      runLaunchctl: fake.run,
    });
    const rows = [
      { bytes: "short\n", mode: 0o600 },
      { bytes: `${capability}\nextra\n`, mode: 0o600 },
      { bytes: `${capability}\n`, mode: 0o644 },
    ];
    for (const row of rows) {
      await writeFile(installed.paths.handoffPath, row.bytes, {
        mode: row.mode,
      });
      await chmod(installed.paths.handoffPath, row.mode);
      await expect(
        execFile("/bin/sh", [
          installed.paths.wrapperPath,
          installed.paths.envPath,
          executablePath,
          "serve",
        ]),
      ).rejects.toBeDefined();
      await expect(lstat(installed.paths.handoffPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    const target = join(root, "handoff-target");
    await writeFile(target, `${capability}\n`, { mode: 0o600 });
    await symlink(target, installed.paths.handoffPath);
    await expect(
      execFile("/bin/sh", [
        installed.paths.wrapperPath,
        installed.paths.envPath,
        executablePath,
        "serve",
      ]),
    ).rejects.toBeDefined();
    await expect(lstat(installed.paths.handoffPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("launchd status and lifecycle", () => {
  it("maps the installed and loaded asymmetries and parsed process fields", async () => {
    const { identity, dependencies } = await fixture();
    const paths = resolveLaunchdServicePaths(identity, dependencies);
    const calls: string[][] = [];
    const loadedRunner = async (args: readonly string[]) => {
      calls.push([...args]);
      return exited(0, "state = running\npid = 4321\nlast exit status = -9\n");
    };
    expect(
      await readLaunchdServiceStatus(identity, {
        ...dependencies,
        runLaunchctl: loadedRunner,
      }),
    ).toMatchObject({
      kind: "registered",
      installed: false,
      loaded: true,
      running: true,
      pid: 4321,
      lastExitStatus: -9,
    });

    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(paths.plistPath, "synthetic", { mode: 0o600 });
    expect(
      await readLaunchdServiceStatus(identity, {
        ...dependencies,
        runLaunchctl: async () => notFound(),
      }),
    ).toMatchObject({
      kind: "registered",
      installed: true,
      loaded: false,
      running: false,
    });
    await rm(paths.plistPath);
    expect(
      await readLaunchdServiceStatus(identity, {
        ...dependencies,
        runLaunchctl: async () => notFound(),
      }),
    ).toMatchObject({ kind: "absent", registered: false });
    expect(calls).toEqual([["print", "gui/501/ai.enduragent.coach.synthetic"]]);
  });

  it("fails closed on symlinks, filesystem errors, and launchctl failures", async () => {
    const { root, identity, dependencies } = await fixture();
    const paths = resolveLaunchdServicePaths(identity, dependencies);
    await mkdir(paths.launchAgentsDir, { recursive: true });
    const target = join(root, "target");
    await writeFile(target, "synthetic");
    await symlink(target, paths.plistPath);
    const runner = vi.fn(async () => exited());
    expect(
      await readLaunchdServiceStatus(identity, {
        ...dependencies,
        runLaunchctl: runner,
      }),
    ).toMatchObject({
      kind: "unknown",
      installed: null,
      detail: "launchd status unavailable",
    });
    expect(runner).not.toHaveBeenCalled();

    const ioError = Object.assign(new Error("private detail"), { code: "EIO" });
    expect(
      await readLaunchdServiceStatus(identity, {
        ...dependencies,
        lstat: async () => {
          throw ioError;
        },
        runLaunchctl: runner,
      }),
    ).toMatchObject({ kind: "unknown", installed: null });
    expect(runner).not.toHaveBeenCalled();

    await rm(paths.plistPath);
    expect(
      await readLaunchdServiceStatus(identity, {
        ...dependencies,
        runLaunchctl: async () => ({
          outcome: "timed-out",
          exitCode: null,
          stdout: "private",
          stderr: "private",
        }),
      }),
    ).toMatchObject({
      kind: "unknown",
      installed: false,
      detail: "launchd status unavailable",
    });
  });

  it("uses destructive kickstart only for explicit restart", async () => {
    const { identity, dependencies } = await fixture();
    const paths = resolveLaunchdServicePaths(identity, dependencies);
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(paths.plistPath, "synthetic", { mode: 0o600 });
    const fake = fakeLaunchctl({ loaded: true, running: false });
    await restartLaunchdService(identity, {
      ...dependencies,
      runLaunchctl: fake.run,
    });
    expect(fake.calls.map((call) => call.slice(0, 2))).toEqual([
      ["print", "gui/501/ai.enduragent.coach.synthetic"],
      ["kickstart", "-k"],
      ["print", "gui/501/ai.enduragent.coach.synthetic"],
    ]);
  });

  it("bootstraps unloaded restart and refuses absent or unknown status", async () => {
    const { identity, dependencies } = await fixture();
    const paths = resolveLaunchdServicePaths(identity, dependencies);
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(paths.plistPath, "synthetic", { mode: 0o600 });
    const fake = fakeLaunchctl();
    await restartLaunchdService(identity, {
      ...dependencies,
      runLaunchctl: fake.run,
    });
    expect(fake.calls.map((call) => call[0])).toEqual(["print", "enable", "bootstrap", "print"]);

    await rm(paths.plistPath);
    await expect(
      restartLaunchdService(identity, {
        ...dependencies,
        runLaunchctl: async () => notFound(),
      }),
    ).rejects.toBeInstanceOf(LaunchdServiceNotInstalledError);
    await expect(
      restartLaunchdService(identity, {
        ...dependencies,
        runLaunchctl: async () => exited(1, "private"),
      }),
    ).rejects.toBeInstanceOf(LaunchdServiceCommandError);
  });

  it("resumes absent, unloaded, stopped, and running registrations exactly", async () => {
    const { identity, dependencies } = await fixture();
    const paths = resolveLaunchdServicePaths(identity, dependencies);
    const absent = fakeLaunchctl();
    await expect(
      resumeLaunchdService(identity, {
        ...dependencies,
        runLaunchctl: absent.run,
      }),
    ).resolves.toBe("not-installed");
    expect(absent.calls.map((call) => call[0])).toEqual(["print"]);

    await mkdir(paths.launchAgentsDir, { recursive: true });
    await writeFile(paths.plistPath, "synthetic", { mode: 0o600 });
    const unloaded = fakeLaunchctl();
    await resumeLaunchdService(identity, {
      ...dependencies,
      runLaunchctl: unloaded.run,
    });
    expect(unloaded.calls.map((call) => call[0])).toEqual(["print", "enable", "bootstrap"]);

    const stopped = fakeLaunchctl({ loaded: true });
    await resumeLaunchdService(identity, {
      ...dependencies,
      runLaunchctl: stopped.run,
    });
    expect(stopped.calls.map((call) => call[0])).toEqual(["print", "kickstart"]);
    expect(stopped.calls[1]).toEqual(["kickstart", "gui/501/ai.enduragent.coach.synthetic"]);

    const running = fakeLaunchctl({ loaded: true, running: true });
    await resumeLaunchdService(identity, {
      ...dependencies,
      runLaunchctl: running.run,
    });
    expect(running.calls.map((call) => call[0])).toEqual(["print"]);
  });

  it("stages designated resume once and removes the carrier on command failure", async () => {
    const { identity, dependencies } = await fixture();
    const paths = resolveLaunchdServicePaths(identity, dependencies);
    await mkdir(paths.launchAgentsDir, { recursive: true });
    await mkdir(paths.stateDir, { recursive: true });
    await writeFile(paths.plistPath, "synthetic", { mode: 0o600 });
    const fake = fakeLaunchctl({ loaded: true });
    await resumeLaunchdServiceAfterEphemeral(
      identity,
      { targetProtocolVersion: 1, handoffCapability: capability },
      { ...dependencies, runLaunchctl: fake.run },
    );
    expect(fake.calls.map((call) => call[0])).toEqual(["print", "kickstart"]);
    expect(await readFile(paths.handoffPath, "utf8")).toBe(`${capability}\n`);

    await rm(paths.handoffPath);
    await expect(
      resumeLaunchdServiceAfterEphemeral(
        identity,
        { targetProtocolVersion: 1, handoffCapability: capability },
        {
          ...dependencies,
          runLaunchctl: async (args) =>
            args[0] === "print" ? exited(0, "state = exited\n") : exited(9, "private"),
        },
      ),
    ).rejects.toBeInstanceOf(LaunchdServiceCommandError);
    await expect(lstat(paths.handoffPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects malformed successor input before launchctl or publication", async () => {
    const { identity, dependencies } = await fixture();
    const runner = vi.fn(async () => exited());
    await expect(
      restartLaunchdServiceForUpgrade(
        identity,
        { targetProtocolVersion: -1, handoffCapability: `${capability}\n` },
        { ...dependencies, runLaunchctl: runner },
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("launchctl adapter and platform boundary", () => {
  it("uses the absolute command, argv, fixed options, and hermetic environment", async () => {
    const { identity, userHome } = await fixture();
    const captured: unknown[][] = [];
    const injectedExecFile = ((...args: unknown[]) => {
      captured.push(args);
      const callback = args[3] as (error: null, stdout: string, stderr: string) => void;
      callback(null, "state = exited\n", "");
      return {};
    }) as unknown as typeof nodeExecFile;
    await readLaunchdServiceStatus(identity, {
      platform: "darwin",
      uid: 501,
      userHome,
      execFile: injectedExecFile,
      lstat: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.[0]).toBe("/bin/launchctl");
    expect(captured[0]?.[1]).toEqual(["print", "gui/501/ai.enduragent.coach.synthetic"]);
    expect(captured[0]?.[2]).toEqual({
      shell: false,
      encoding: "utf8",
      timeout: 5_000,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: userHome,
      },
    });
  });

  it.each([
    {
      error: Object.assign(new Error("nonzero"), { code: 113 }),
      expected: "absent",
      stderr: "service not found",
    },
    {
      error: Object.assign(new Error("nonzero"), { code: 7 }),
      expected: "unknown",
      stderr: "other",
    },
    {
      error: Object.assign(new Error("timeout"), { killed: true }),
      expected: "unknown",
      stderr: "",
    },
    {
      error: Object.assign(new Error("signal"), { signal: "SIGTERM" }),
      expected: "unknown",
      stderr: "",
    },
    {
      error: Object.assign(new Error("spawn"), { code: "ENOENT" }),
      expected: "unknown",
      stderr: "",
    },
  ])("normalizes callback error outcomes as $expected", async ({ error, expected, stderr }) => {
    const { identity, userHome } = await fixture();
    const injectedExecFile = ((
      _file: unknown,
      _args: unknown,
      _options: unknown,
      callback: (error: Error, stdout: unknown, stderr: unknown) => void,
    ) => {
      callback(error, Buffer.from("ignored"), stderr);
      return {};
    }) as unknown as typeof nodeExecFile;
    const status = await readLaunchdServiceStatus(identity, {
      platform: "darwin",
      uid: 501,
      userHome,
      execFile: injectedExecFile,
      lstat: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
    });
    expect(status.kind).toBe(expected);
  });

  it("rejects every status or mutation on non-darwin without side effects", async () => {
    const { identity, userHome } = await fixture();
    const runner = vi.fn(async () => exited());
    const dependencies = {
      platform: "linux" as const,
      uid: 501,
      userHome,
      runLaunchctl: runner,
    };
    const operations = [
      () => readLaunchdServiceStatus(identity, dependencies),
      () => installLaunchdService(identity, dependencies),
      () => uninstallLaunchdService(identity, dependencies),
      () => restartLaunchdService(identity, dependencies),
      () => resumeLaunchdService(identity, dependencies),
      () =>
        restartLaunchdServiceForUpgrade(
          identity,
          { targetProtocolVersion: 1, handoffCapability: capability },
          dependencies,
        ),
      () =>
        resumeLaunchdServiceAfterEphemeral(
          identity,
          { targetProtocolVersion: 1, handoffCapability: capability },
          dependencies,
        ),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toBeInstanceOf(UnsupportedLaunchdPlatformError);
    }
    expect(runner).not.toHaveBeenCalled();
  });
});
