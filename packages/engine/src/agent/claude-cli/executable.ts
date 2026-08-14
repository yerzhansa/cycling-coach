import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve as resolvePath, win32 } from "node:path";

import { buildChildEnv, expandTilde, readEnvironmentValue, type ClaudeCliRuntime } from "./env.js";
import { ClaudeCliConfigError, binaryMissingError, versionBelowFloorError } from "./errors.js";
import { buildClaudeCliSpawnInvocation } from "./session.js";
import type { ClaudeWorkingAreaPort } from "./working-area.js";

export const CLAUDE_CLI_VERSION_FLOOR = "2.1.220";

const VERSION_PROBE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_MAX_BYTES = 64 * 1024;
const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

export interface WellKnownClaudePathsOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

export function wellKnownClaudePaths(
  home: string,
  options: WellKnownClaudePathsOptions = {},
): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const env = options.env ?? process.env;
    const appData =
      readEnvironmentValue(env, "APPDATA", platform) ?? win32.join(home, "AppData", "Roaming");
    const localAppData =
      readEnvironmentValue(env, "LOCALAPPDATA", platform) ?? win32.join(home, "AppData", "Local");
    return [
      win32.join(home, ".local", "bin", "claude.exe"),
      win32.join(localAppData, "Microsoft", "WinGet", "Links", "claude.exe"),
      win32.join(appData, "npm", "claude.cmd"),
    ];
  }
  return [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
  ];
}

export function hasSupportedWindowsClaudeExtension(candidate: string): boolean {
  const extension = win32.extname(candidate).toLowerCase();
  return extension === ".exe" || extension === ".cmd";
}

async function defaultIsExecutable(candidate: string, platform: NodeJS.Platform): Promise<boolean> {
  if (platform === "win32" && !hasSupportedWindowsClaudeExtension(candidate)) return false;
  try {
    await access(candidate, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveClaudeBinaryOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  isExecutable?: (candidate: string) => Promise<boolean>;
}

export async function resolveClaudeBinary(
  options: ResolveClaudeBinaryOptions = {},
): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home =
    options.home ??
    (platform === "win32" ? readEnvironmentValue(env, "USERPROFILE", platform) : env.HOME) ??
    homedir();
  const isExecutable =
    options.isExecutable ?? ((candidate: string) => defaultIsExecutable(candidate, platform));
  const canUse = async (candidate: string): Promise<boolean> => {
    if (platform === "win32" && !hasSupportedWindowsClaudeExtension(candidate)) return false;
    return await isExecutable(candidate);
  };

  const explicit = options.explicitPath;
  if (explicit !== undefined && explicit !== "") {
    const expanded =
      platform === "win32" ? expandTilde(explicit, { platform, env, home }) : expandTilde(explicit);
    const resolved =
      platform === "win32"
        ? win32.isAbsolute(expanded)
          ? expanded
          : win32.resolve(expanded)
        : isAbsolute(expanded)
          ? expanded
          : resolvePath(expanded);
    if (platform !== "win32") return resolved;
    return (await canUse(resolved)) ? resolved : null;
  }

  const pathValue = readEnvironmentValue(env, "PATH", platform) ?? "";
  const pathDelimiter = platform === "win32" ? win32.delimiter : delimiter;
  const pathJoin = platform === "win32" ? win32.join : join;
  const executableNames = platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const entry of pathValue.split(pathDelimiter)) {
    if (entry === "") continue;
    for (const name of executableNames) {
      const candidate = pathJoin(entry, name);
      if (await canUse(candidate)) return candidate;
    }
  }

  for (const candidate of wellKnownClaudePaths(home, { platform, env })) {
    if (await canUse(candidate)) return candidate;
  }

  return null;
}

export interface ProbeVersionOptions {
  workingArea: ClaudeWorkingAreaPort;
  runtime?: ClaudeCliRuntime;
  baseEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  timeoutMs?: number;
  maxBytes?: number;
  spawn?: typeof spawn;
}

export function parseClaudeVersion(output: string): string | null {
  const match = VERSION_PATTERN.exec(output);
  return match === null ? null : `${match[1]}.${match[2]}.${match[3]}`;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export function assertVersionAtLeast(
  version: string,
  floor = CLAUDE_CLI_VERSION_FLOOR,
  platform: NodeJS.Platform = process.platform,
): void {
  if (compareVersions(version, floor) < 0) {
    throw versionBelowFloorError(version, floor, platform);
  }
}

export async function probeVersion(
  binaryPath: string,
  options: ProbeVersionOptions,
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? VERSION_PROBE_MAX_BYTES;
  const runtime: ClaudeCliRuntime = options.runtime ?? {
    binaryPath,
    billing: "subscription",
  };
  const env = buildChildEnv(options.baseEnv ?? process.env, runtime, {
    platform,
    ...(options.home === undefined ? {} : { home: options.home }),
  });
  const invocation = buildClaudeCliSpawnInvocation({
    binaryPath,
    args: ["--version"],
    env,
    platform,
  });
  const launch = options.spawn ?? spawn;
  const binding = await options.workingArea.prepareForLaunch("version");

  const raw = await new Promise<string>((resolve, reject) => {
    binding.assertCurrent();
    const child = launch(invocation.command, [...invocation.args], {
      cwd: binding.cwd,
      shell: invocation.shell,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: invocation.windowsHide,
      ...(invocation.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
      env,
    });

    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflowed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const append = (chunk: Buffer, target: "stdout" | "stderr"): void => {
      const text = chunk.toString("utf8");
      const len = Buffer.byteLength(text, "utf8");
      if (target === "stdout") {
        stdoutBytes += len;
        if (stdoutBytes > maxBytes) {
          if (!overflowed) {
            overflowed = true;
            child.kill("SIGKILL");
          }
          return;
        }
        stdout += text;
      } else {
        stderrBytes += len;
        if (stderrBytes > maxBytes) {
          if (!overflowed) {
            overflowed = true;
            child.kill("SIGKILL");
          }
          return;
        }
        stderr += text;
      }
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        reject(binaryMissingError(binaryPath, platform));
        return;
      }
      if (platform === "win32") {
        reject(binaryMissingError(binaryPath, platform));
        return;
      }
      reject(
        new ClaudeCliConfigError(
          "binary-missing",
          `Claude Code CLI at ${binaryPath} failed to spawn: ${err.message}`,
        ),
      );
    });

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (overflowed) {
        reject(
          new ClaudeCliConfigError(
            "binary-missing",
            `Claude Code CLI version probe output exceeded ${maxBytes} bytes.`,
          ),
        );
        return;
      }
      if (timedOut) {
        reject(
          new ClaudeCliConfigError(
            "probe-timeout",
            `Claude Code CLI version probe timed out after ${timeoutMs}ms.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        if (platform === "win32") {
          reject(
            new ClaudeCliConfigError(
              "binary-missing",
              `Claude Code CLI version probe exited with code ${code}. ${binaryMissingError(binaryPath, platform).message}`,
            ),
          );
          return;
        }
        const tail = stderr.slice(-200).trim();
        reject(
          new ClaudeCliConfigError(
            "binary-missing",
            `Claude Code CLI at ${binaryPath} exited with code ${code}${tail ? `: ${tail}` : "."}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });

  const version = parseClaudeVersion(raw);
  if (version === null) {
    if (platform === "win32") {
      throw new ClaudeCliConfigError(
        "binary-missing",
        `Claude Code CLI did not report a version. ${binaryMissingError(binaryPath, platform).message}`,
      );
    }
    throw new ClaudeCliConfigError(
      "binary-missing",
      `Claude Code CLI at ${binaryPath} did not report a version: ${raw.slice(0, 200).trim()}`,
    );
  }
  return version;
}
