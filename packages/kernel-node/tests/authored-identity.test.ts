import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAuthoredIdentity } from "../src/store/authored-identity.js";

const roots: string[] = [];

async function freshConfigDir(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), "authored-identity-"));
  roots.push(root);
  return join(root, "config");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authored identity", () => {
  it("persists one stable private device id across factory instances", async () => {
    const configDir = await freshConfigDir();
    const first = createAuthoredIdentity(configDir);
    const firstId = await first.deviceId();
    const secondId = await createAuthoredIdentity(configDir).deviceId();
    const path = join(configDir, "device-id");
    expect(secondId).toBe(firstId);
    expect(await readFile(path, "utf8")).toBe(`${firstId}\n`);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("generates shaped monotonic ULIDs within one millisecond", () => {
    const identity = createAuthoredIdentity("/synthetic/config", {
      now: () => 1_721_260_800_000,
      randomBytes: (size) => new Uint8Array(size),
    });
    const first = identity.newUlid();
    const second = identity.newUlid();
    expect(first).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second > first).toBe(true);
  });

  it("guards HLC monotonicity while the clock stalls and regresses", () => {
    const times = [100, 100, 99, 101];
    const identity = createAuthoredIdentity("/synthetic/config", {
      now: () => times.shift() ?? 101,
    });
    expect(identity.hlcStamp()).toEqual({ physicalMs: 100, counter: 0 });
    expect(identity.hlcStamp()).toEqual({ physicalMs: 100, counter: 1 });
    expect(identity.hlcStamp()).toEqual({ physicalMs: 100, counter: 2 });
    expect(identity.hlcStamp()).toEqual({ physicalMs: 101, counter: 0 });
  });
});
