import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";

import { createFakeClaude, type FakeClaude } from "./helpers/fake-claude.js";
import { buildChildEnv } from "../../src/agent/claude-cli/env.js";

let fake: FakeClaude | null = null;

afterEach(async () => {
  if (fake !== null) {
    await fake.cleanup();
    fake = null;
  }
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function run(
  binaryPath: string,
  args: string[],
  stdin: string,
  killAfterMs?: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(binaryPath, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildChildEnv(process.env, { binaryPath, billing: "subscription" }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    if (killAfterMs !== undefined) setTimeout(() => child.kill("SIGKILL"), killAfterMs);
    child.stdin.write(stdin);
    child.stdin.end();
    child.on("close", (code) => resolve({ stdout, stderr, code }));
  });
}

describe("fake Claude CLI harness", () => {
  it("records argv, the child environment and the inbound frames, then replays the script", async () => {
    fake = await createFakeClaude({ script: "happy-turn" });
    const inbound = '{"type":"user","message":{"role":"user","content":"how is my week"}}\n';

    const result = await run(
      fake.binaryPath,
      ["--output-format", "stream-json", "--verbose"],
      inbound,
    );

    expect(result.code).toBe(0);
    expect(await fake.readArgv()).toEqual(["--output-format", "stream-json", "--verbose"]);
    expect(await fake.readFramesIn()).toEqual([inbound.trim()]);

    const childEnv = await fake.readEnv();
    expect(childEnv.PATH).toBeDefined();
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();

    const frames = result.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type: string; subtype?: string });
    expect(frames[0]).toMatchObject({ type: "system", subtype: "init" });
    expect(frames.some((frame) => frame.type === "stream_event")).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: "result", subtype: "success" });
  });

  it("emits nothing for the never-init script", async () => {
    fake = await createFakeClaude({ script: "never-init" });
    const result = await run(fake.binaryPath, ["--verbose"], "", 400);
    expect(result.stdout).toBe("");
  });

  it("fails loudly on an unknown script name", async () => {
    fake = await createFakeClaude({ script: "no-such-script" });
    const result = await run(fake.binaryPath, ["--verbose"], "");
    expect(result.code).toBe(66);
    expect(result.stderr).toContain("unknown script no-such-script");
  });
});
