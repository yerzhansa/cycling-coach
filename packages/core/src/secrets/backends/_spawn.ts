import { spawn } from "node:child_process";

export type SpawnResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type SpawnOptions = {
  timeoutMs: number;
};

export function spawnCapture(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
): Promise<SpawnResult> {
  return runSpawn(cmd, args, opts, null);
}

export function spawnStdin(
  cmd: string,
  args: string[],
  stdinData: string,
  opts: SpawnOptions,
): Promise<SpawnResult> {
  return runSpawn(cmd, args, opts, stdinData);
}

function runSpawn(
  cmd: string,
  args: string[],
  opts: SpawnOptions,
  stdinData: string | null,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    const child = spawn(cmd, args, {
      shell: false,
      stdio: [stdinData === null ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole process group, not just the direct child, so a forked
      // grandchild can't keep the inherited stdio pipes open and stall "close".
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr, timedOut });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });

    if (stdinData !== null && child.stdin) {
      child.stdin.on("error", () => {
        // Swallow EPIPE when child exits before reading stdin; the close
        // handler above will resolve with whatever was captured.
      });
      child.stdin.end(stdinData, "utf8");
    }
  });
}
