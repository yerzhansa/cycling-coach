import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";

import { buildChildEnv, expandTilde, type ClaudeCliRuntime } from "./env.js";
import { ClaudeCliConfigError, binaryMissingError, versionBelowFloorError } from "./errors.js";

export const CLAUDE_CLI_VERSION_FLOOR = "2.1.220";

const VERSION_PROBE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_MAX_BYTES = 64 * 1024;
const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/;

export function wellKnownClaudePaths(home: string): string[] {
  return [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    join(home, ".local", "bin", "claude"),
    join(home, ".claude", "local", "claude"),
  ];
}

async function defaultIsExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface ResolveClaudeBinaryOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  isExecutable?: (candidate: string) => Promise<boolean>;
}

export async function resolveClaudeBinary(
  options: ResolveClaudeBinaryOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const isExecutable = options.isExecutable ?? defaultIsExecutable;

  const explicit = options.explicitPath;
  if (explicit !== undefined && explicit !== "") {
    const expanded = expandTilde(explicit);
    return isAbsolute(expanded) ? expanded : resolvePath(expanded);
  }

  const pathValue = env.PATH ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(entry, "claude");
    if (await isExecutable(candidate)) return candidate;
  }

  for (const candidate of wellKnownClaudePaths(home)) {
    if (await isExecutable(candidate)) return candidate;
  }

  return null;
}

export interface ProbeVersionOptions {
  runtime?: ClaudeCliRuntime;
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
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

export function assertVersionAtLeast(version: string, floor = CLAUDE_CLI_VERSION_FLOOR): void {
  if (compareVersions(version, floor) < 0) throw versionBelowFloorError(version, floor);
}

export async function probeVersion(
  binaryPath: string,
  options: ProbeVersionOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? VERSION_PROBE_MAX_BYTES;
  const runtime: ClaudeCliRuntime = options.runtime ?? {
    binaryPath,
    billing: "subscription",
  };
  const env = buildChildEnv(options.baseEnv ?? process.env, runtime);

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(binaryPath, ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
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
        reject(binaryMissingError(binaryPath));
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
    throw new ClaudeCliConfigError(
      "binary-missing",
      `Claude Code CLI at ${binaryPath} did not report a version: ${raw.slice(0, 200).trim()}`,
    );
  }
  return version;
}
