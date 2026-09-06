import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { arch, release, tmpdir, version } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";
import { bindWindowsPrivateDirectory } from "@enduragent/core";
import { connectCdp, reservePort, waitForPage } from "./support/desktop-cdp.js";
import { syntheticOAuthCredential } from "./support/packaged-telegram/oauth-provider-fixture.js";
import { withAcceptanceDeadline } from "./support/packaged-telegram/acceptance-deadline.js";
import { readWindowsPrivateFile } from "../src/main/windows-private-file.js";

export function assertNativeOAuthHost(
  platform: NodeJS.Platform,
  architecture: string,
  environment: NodeJS.ProcessEnv,
): void {
  assert.equal(platform, "win32", "native OAuth acceptance requires Windows");
  assert.equal(architecture, "x64", "native OAuth acceptance requires x64 Electron");
  assert.equal(
    environment.GITHUB_ACTIONS,
    "true",
    "native OAuth acceptance requires a disposable runner",
  );
  assert.equal(environment.RUNNER_ENVIRONMENT, "github-hosted");
}

export function nativeOAuthEnvironment(
  scratch: string,
  parent: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    SystemRoot: parent.SystemRoot,
    WINDIR: parent.WINDIR,
    PATH: parent.PATH,
    COMSPEC: parent.COMSPEC,
    PATHEXT: parent.PATHEXT,
    USERPROFILE: join(scratch, "profile"),
    HOME: join(scratch, "profile"),
    LOCALAPPDATA: join(scratch, "local"),
    APPDATA: join(scratch, "roaming"),
    TEMP: join(scratch, "temp"),
    TMP: join(scratch, "temp"),
    ENDURAGENT_HOME: join(scratch, "athlete"),
    ENDURAGENT_ACCEPTANCE_HIDDEN: "1",
    ENDURAGENT_NO_USAGE_PING: "1",
  };
}

async function main(): Promise<void> {
  assertNativeOAuthHost(process.platform, process.arch, process.env);
  assert.equal(process.argv.length, 4);
  assert.equal(process.argv[2], "--executable");
  const executable = process.argv[3];
  assert(executable !== undefined && isAbsolute(executable));
  const archive = join(dirname(executable), "resources", "app.asar");
  const manifest: unknown = JSON.parse(extractFile(archive, "package.json").toString());
  assert(manifest !== null && typeof manifest === "object");
  assert("name" in manifest && manifest.name === "@enduragent/desktop");
  assert("version" in manifest && typeof manifest.version === "string");
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "enduragent-native-oauth-"));
  const localAppData = join(scratch, "local");
  const userData = join(localAppData, "Enduragent");
  const athleteHome = join(scratch, "athlete");
  const configDirectory = join(athleteHome, "config");
  const profilesPath = join(configDirectory, "auth-profiles.json");
  const envelopePath = join(userData, "credentials-v1", "oauth.bin");
  const credential = syntheticOAuthCredential();
  const markers = [credential.access, credential.refresh, credential.accountId];
  const runFile = promisify(execFile);
  const powershell = join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  let stage = "private scratch preparation";
  let active:
    | {
        child: ChildProcess;
        terminal: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
        cdp?: Awaited<ReturnType<typeof connectCdp>>;
        output: string;
        outputExceeded: boolean;
      }
    | undefined;
  const report = {
    ok: false,
    nativeDpapiVerified: false,
    platform: process.platform,
    architecture: arch(),
    operatingSystem: version(),
    operatingSystemRelease: release(),
    hostArchitecture: "",
    packageVersion: manifest.version,
    archiveSha256: createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
    checks: [] as string[],
    failureStage: null as string | null,
  };

  function markerFree(value: string | Buffer): void {
    for (const marker of markers)
      assert(!value.includes(marker), "synthetic credential escaped private storage");
  }

  async function native(command: string): Promise<string> {
    const result = await runFile(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        env: {
          ...process.env,
          ENDURAGENT_NATIVE_OAUTH_SCRATCH: scratch,
          ENDURAGENT_NATIVE_OAUTH_ENVELOPE: envelopePath,
        },
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 16_384,
      },
    );
    return result.stdout.trim();
  }

  async function evaluate(expression: string): Promise<unknown> {
    assert(active?.cdp !== undefined);
    const result = await withAcceptanceDeadline(
      "native OAuth renderer call",
      active.cdp.call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }),
      { timeoutMs: 15_000 },
    );
    assert(!("exceptionDetails" in result));
    const remote = result.result;
    assert(remote !== null && typeof remote === "object" && "value" in remote);
    markerFree(JSON.stringify(remote.value));
    return remote.value;
  }

  async function waitForStatus(configured: boolean): Promise<void> {
    const deadline = performance.now() + 35_000;
    while (performance.now() < deadline) {
      const state = await evaluate("window.enduragentAuth.chatgptStatus()");
      if (
        state !== null &&
        typeof state === "object" &&
        "state" in state &&
        "runtimeReady" in state &&
        state.state === (configured ? "configured" : "absent") &&
        state.runtimeReady === configured
      )
        return;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error("native OAuth status did not settle");
  }

  async function launch(): Promise<void> {
    assert(active === undefined);
    const port = await reservePort();
    const environment = nativeOAuthEnvironment(scratch, process.env);
    const child = spawn(executable, [`--remote-debugging-port=${port}`], {
      cwd: scratch,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolveExit({ code, signal }));
      },
    );
    void terminal.catch(() => {});
    const processState = { child, terminal, output: "", outputExceeded: false };
    active = processState;
    const capture = (chunk: Buffer): void => {
      if (processState.output.length + chunk.length > 1_048_576) processState.outputExceeded = true;
      else processState.output += chunk.toString();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const debuggerUrl = await waitForPage(port, { timeoutMs: 40_000 });
    const address = new URL(debuggerUrl);
    assert.equal(address.protocol, "ws:");
    assert.equal(address.hostname, "127.0.0.1");
    assert.equal(address.port, String(port));
    assert(child.pid !== undefined);
    const listenerOwner = await native(
      `$ErrorActionPreference='Stop'; $listeners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop); if($listeners.Count -eq 0 -or @($listeners | Where-Object {$_.OwningProcess -ne ${child.pid}}).Count -ne 0){throw 'unexpected debugger owner'}; 'owned'`,
    );
    assert.equal(listenerOwner, "owned");
    active.cdp = await connectCdp(debuggerUrl, () => {});
  }

  async function stop(): Promise<void> {
    const current = active;
    if (current === undefined) return;
    try {
      if (current.cdp !== undefined) {
        await withAcceptanceDeadline(
          "native OAuth close request",
          current.cdp.call("Browser.close").catch(() => ({})),
          { timeoutMs: 5_000 },
        );
      }
      const result = await withAcceptanceDeadline(
        "native OAuth application shutdown",
        current.terminal,
        { timeoutMs: 15_000 },
      );
      assert.deepEqual(result, { code: 0, signal: null });
      assert(!current.outputExceeded);
      markerFree(current.output);
    } finally {
      current.cdp?.socket.close();
      if (current.child.exitCode === null && current.child.signalCode === null) {
        current.child.kill("SIGKILL");
        await withAcceptanceDeadline(
          "native OAuth owned process cleanup",
          current.terminal.catch(() => undefined),
          { timeoutMs: 10_000 },
        );
      }
      active = undefined;
    }
  }

  async function inspectEnvelope(): Promise<Buffer> {
    const directory = bindWindowsPrivateDirectory(userData, dirname(envelopePath));
    const snapshot = await readWindowsPrivateFile({
      directory,
      path: envelopePath,
      minimumBytes: 16,
      maximumBytes: 262_144,
    });
    assert(snapshot !== undefined);
    markerFree(snapshot.contents);
    assert.equal(
      snapshot.contents.subarray(0, 3).toString(),
      "v10",
      "native safeStorage ciphertext header is absent",
    );
    assert.deepEqual(JSON.parse(await readFile(profilesPath, "utf8")), {});
    await assert.rejects(lstat(join(userData, ".enduragent-acceptance-key")), { code: "ENOENT" });
    const result = await native(
      "$ErrorActionPreference='Stop'; $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); $acl=Get-Acl -LiteralPath $env:ENDURAGENT_NATIVE_OAUTH_ENVELOPE; foreach($rule in $acl.Access){if($rule.AccessControlType -eq 'Allow' -and $allowed -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value){throw 'credential ACL allows another principal'}}; 'private'",
    );
    assert.equal(result, "private");
    return snapshot.contents;
  }

  try {
    await native(
      "$ErrorActionPreference='Stop'; $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); foreach($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')){$identity=New-Object Security.Principal.SecurityIdentifier($sid); $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule)}; Set-Acl -LiteralPath $env:ENDURAGENT_NATIVE_OAUTH_SCRATCH -AclObject $acl",
    );
    report.hostArchitecture = await native(
      "[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()",
    );
    assert.equal(report.hostArchitecture, "X64", "native OAuth acceptance refuses host emulation");
    for (const path of [
      configDirectory,
      userData,
      join(scratch, "profile"),
      join(scratch, "roaming"),
      join(scratch, "temp"),
    ])
      await mkdir(path, { recursive: true });
    await writeFile(
      join(configDirectory, "config.yaml"),
      [
        "data_source: store",
        `data_dir: ${JSON.stringify(athleteHome)}`,
        "llm:",
        "  provider: openai-codex",
        "  model: gpt-5.5",
        "  auth_profile: openai-codex",
        "intervals:",
        "  api_key: ''",
        "  athlete_id: '0'",
        "session:",
        "  timezone: UTC",
        "",
      ].join("\n"),
    );
    await writeFile(profilesPath, JSON.stringify({ "openai-codex": credential }));
    stage = "native migration and save";
    await launch();
    await waitForStatus(true);
    const ciphertext = await inspectEnvelope();
    report.checks.push(
      "production owner migrated synthetic credentials into private native safeStorage ciphertext",
    );
    await stop();
    stage = "native reopen after process restart";
    await launch();
    await waitForStatus(true);
    assert.deepEqual(await inspectEnvelope(), ciphertext);
    report.checks.push(
      "new installed application process reopened the same ciphertext with configured runtime",
    );
    stage = "production credential deletion";
    const deletion = await evaluate(
      "window.enduragentAuth.deleteCredential({credential:'openai-codex'})",
    );
    assert(
      deletion !== null &&
        typeof deletion === "object" &&
        "status" in deletion &&
        deletion.status === "deleted",
    );
    await assert.rejects(lstat(envelopePath), { code: "ENOENT" });
    await stop();
    stage = "native deletion persistence";
    await launch();
    await waitForStatus(false);
    await assert.rejects(lstat(envelopePath), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(profilesPath, "utf8")), {});
    await stop();
    report.checks.push(
      "production credential deletion remained absent after a third application launch",
    );
    report.nativeDpapiVerified = true;
    report.ok = true;
  } catch {
    report.failureStage = stage;
    process.exitCode = 1;
  } finally {
    try {
      await stop();
    } catch {
      report.ok = false;
      report.nativeDpapiVerified = false;
      report.failureStage = "owned process cleanup";
      process.exitCode = 1;
    }
    try {
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      report.ok = false;
      report.nativeDpapiVerified = false;
      report.failureStage = "private scratch cleanup";
      process.exitCode = 1;
    }
    if (!report.ok) process.stderr.write(`${JSON.stringify(report)}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
