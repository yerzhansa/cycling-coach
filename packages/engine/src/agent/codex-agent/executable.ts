import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";

import {
  CodexAgentConfigError,
  binaryMissingError,
  redactSecretShapes,
  versionBelowFloorError,
} from "./errors.js";
import { buildSpawnOptions } from "./session.js";
import { CODEX_VERSION_FLOOR, compareVersions } from "./version.js";

const VERSION_PROBE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_MAX_BYTES = 64 * 1024;
const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/;
const STDERR_TAIL_BYTES = 200;

export function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolvePath(homedir(), value.slice(2));
  return value;
}

export function wellKnownCodexPaths(home: string): string[] {
  return [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    join(home, ".local", "bin", "codex"),
  ];
}

export function nvmCodexRoot(home: string): string {
  return join(home, ".nvm", "versions", "node");
}

async function defaultIsExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultListDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

export interface ResolveCodexBinaryOptions {
  explicitPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  isExecutable?: (candidate: string) => Promise<boolean>;
  listDirectory?: (directory: string) => Promise<string[]>;
}

export async function resolveCodexBinary(
  options: ResolveCodexBinaryOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const listDirectory = options.listDirectory ?? defaultListDirectory;

  const explicit = options.explicitPath;
  if (explicit !== undefined && explicit !== "") {
    const expanded = expandTilde(explicit);
    return isAbsolute(expanded) ? expanded : resolvePath(expanded);
  }

  const pathValue = env.PATH ?? "";
  for (const entry of pathValue.split(delimiter)) {
    if (entry === "") continue;
    const candidate = join(expandTilde(entry), "codex");
    if (await isExecutable(candidate)) return candidate;
  }

  for (const candidate of wellKnownCodexPaths(home)) {
    if (await isExecutable(candidate)) return candidate;
  }

  const nvmRoot = nvmCodexRoot(home);
  const versions = (await listDirectory(nvmRoot)).sort((a, b) => compareVersions(b, a));
  for (const version of versions) {
    const candidate = join(nvmRoot, version, "bin", "codex");
    if (await isExecutable(candidate)) return candidate;
  }

  return null;
}

export function parseCodexVersion(output: string): string | null {
  const match = VERSION_PATTERN.exec(output);
  if (match === null) return null;
  return `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}`;
}

export function assertVersionAtLeast(version: string, floor = CODEX_VERSION_FLOOR): void {
  if (compareVersions(version, floor) < 0) throw versionBelowFloorError(version, floor);
}

export interface ProbeVersionOptions {
  baseEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
}

export async function probeVersion(
  binaryPath: string,
  options: ProbeVersionOptions = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? VERSION_PROBE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? VERSION_PROBE_MAX_BYTES;
  const spawnOptions = buildSpawnOptions({
    binaryPath,
    baseEnv: options.baseEnv ?? process.env,
    args: ["--version"],
    stdio: ["ignore", "pipe", "pipe"],
  });

  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(spawnOptions.command, [...spawnOptions.args], {
      shell: spawnOptions.shell,
      stdio: [...spawnOptions.stdio],
      windowsHide: spawnOptions.windowsHide,
      env: spawnOptions.env,
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
        new CodexAgentConfigError(
          "binary-missing",
          `Codex CLI at ${binaryPath} failed to spawn: ${err.message}`,
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
          new CodexAgentConfigError(
            "binary-missing",
            `Codex CLI version probe output exceeded ${maxBytes} bytes.`,
          ),
        );
        return;
      }
      if (timedOut) {
        reject(
          new CodexAgentConfigError(
            "probe-timeout",
            `Codex CLI version probe timed out after ${timeoutMs}ms.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const tail = redactSecretShapes(stderr.slice(-STDERR_TAIL_BYTES).trim());
        reject(
          new CodexAgentConfigError(
            "binary-missing",
            `Codex CLI at ${binaryPath} exited with code ${code}${tail ? `: ${tail}` : "."}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });

  const version = parseCodexVersion(raw);
  if (version === null) {
    throw new CodexAgentConfigError(
      "binary-missing",
      `Codex CLI at ${binaryPath} did not report a version: ${redactSecretShapes(raw.slice(0, 200).trim())}`,
    );
  }
  return version;
}
