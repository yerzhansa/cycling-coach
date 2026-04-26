import { spawn } from "node:child_process";
import { SecretRef, SecretResolutionError } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

export async function resolveSecretRef(ref: SecretRef): Promise<string> {
  if (ref.source === "env") {
    return resolveEnvRef(ref.var);
  }
  return await _resolveSecretRefWithOverrides(ref, {});
}

function resolveEnvRef(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new SecretResolutionError(
      "ENOENT",
      `Secret env var '${name}' is not set.`,
    );
  }
  if (value === "") {
    throw new SecretResolutionError(
      "EMPTY",
      `Secret env var '${name}' is set but empty.`,
    );
  }
  return value;
}

export async function _resolveSecretRefWithOverrides(
  ref: Extract<SecretRef, { source: "exec" }>,
  overrides: { timeoutMs?: number; maxBytes?: number },
): Promise<string> {
  const timeoutMs = overrides.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = overrides.maxBytes ?? DEFAULT_MAX_BYTES;
  const cmd = ref.command;
  const args = ref.args ?? [];

  return await new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
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
        reject(
          new SecretResolutionError(
            "ENOENT",
            `Secret resolver command '${cmd}' not found. Is it installed and on $PATH? (Mac launchd users: use absolute path like '/usr/local/bin/op'.)`,
          ),
        );
      } else {
        reject(
          new SecretResolutionError(
            "EXIT_NONZERO",
            `Secret resolver command '${cmd}' failed to spawn: ${err.message}`,
          ),
        );
      }
    });

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (overflowed) {
        reject(
          new SecretResolutionError(
            "OVERFLOW",
            `Secret resolver '${cmd}' output exceeded ${maxBytes} bytes.`,
          ),
        );
        return;
      }
      if (timedOut) {
        reject(
          new SecretResolutionError(
            "TIMEOUT",
            `Secret resolver '${cmd}' timed out after ${timeoutMs}ms.`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const tail = stderr.slice(-200).trim();
        reject(
          new SecretResolutionError(
            "EXIT_NONZERO",
            `Secret resolver '${cmd}' exited with code ${code}${tail ? `: ${tail}` : "."}`,
          ),
        );
        return;
      }

      const trimmed = stdout.replace(/\r?\n$/, "");
      if (trimmed.length === 0) {
        reject(
          new SecretResolutionError(
            "EMPTY",
            `Secret resolver '${cmd}' produced empty output.`,
          ),
        );
        return;
      }
      resolve(trimmed);
    });
  });
}
