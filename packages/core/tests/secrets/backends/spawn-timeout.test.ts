import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCapture, spawnStdin } from "../../../src/secrets/backends/_spawn.js";

const stubDirs: string[] = [];

async function makeSleepStub(script: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "spawn-timeout-"));
  stubDirs.push(dir);
  const path = join(dir, "stub");
  await writeFile(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
}

afterEach(async () => {
  while (stubDirs.length > 0) {
    const dir = stubDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe("spawn timeout group-kill", () => {
  it("resolves at ~timeoutMs even when a grandchild outlives the kill", async () => {
    const stub = await makeSleepStub("sleep 5");
    const start = Date.now();
    const res = await spawnCapture(stub, [], { timeoutMs: 200 });
    const elapsed = Date.now() - start;
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBe(null);
    // The fix resolves at ~205 ms; unfixed it waits for the sleep 5 grandchild
    // (~5000 ms). 2000 ms cleanly separates the two and absorbs CI jitter.
    expect(elapsed).toBeLessThan(2000);
  });

  it("times out the stdin entry point the same way", async () => {
    const stub = await makeSleepStub("sleep 5");
    const start = Date.now();
    const res = await spawnStdin(stub, [], "payload", { timeoutMs: 200 });
    expect(res.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("lets a fast stub resolve normally well under the timeout", async () => {
    const stub = await makeSleepStub("printf 'hello'");
    const res = await spawnCapture(stub, [], { timeoutMs: 5000 });
    expect(res.timedOut).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello");
  });
});
