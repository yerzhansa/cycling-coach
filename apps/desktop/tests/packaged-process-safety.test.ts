import { describe, expect, it, vi } from "vitest";
import {
  classifyDarwinProcessObservation,
  parseDarwinProcessObservation,
  releaseAcceptanceStorage,
  type DarwinProcessBirthIdentity,
} from "./fixtures/packaged-telegram/process-safety.js";

const bundleRoot = "/tmp/Enduragent Telegram Acceptance.app";
const command = `${bundleRoot}/Contents/MacOS/Enduragent Telegram Acceptance --flag`;
const startToken = "Thu Aug  6 13:45:12 2026";

function running(pid = 123, token = startToken, processCommand = command) {
  return parseDarwinProcessObservation(
    {
      code: 0,
      signal: null,
      stdout: Buffer.from(`  ${pid} ${token} ${processCommand}\n`),
      stderr: Buffer.alloc(0),
    },
    pid,
    bundleRoot,
  );
}

describe("packaged process identity", () => {
  it("matches only the captured birth token and exact command identity", () => {
    const tracked = (running() as { state: "running"; identity: DarwinProcessBirthIdentity })
      .identity;

    expect(classifyDarwinProcessObservation(tracked, running())).toBe("same");
    expect(classifyDarwinProcessObservation(tracked, { state: "absent" })).toBe("exited");
    expect(
      classifyDarwinProcessObservation(tracked, running(123, "Thu Aug  6 13:45:13 2026")),
    ).toBe("reused");
    expect(
      classifyDarwinProcessObservation(
        tracked,
        running(123, startToken, `${bundleRoot}/Contents/Frameworks/Other Helper --flag`),
      ),
    ).toBe("reused");
  });

  it("rejects a command outside the acceptance bundle", () => {
    expect(() => running(123, startToken, "/usr/bin/other --flag")).toThrow(
      "tracked process identity is outside the acceptance bundle",
    );
  });

  it("fails closed when an exit-1 observation carries diagnostic stderr", () => {
    expect(() =>
      parseDarwinProcessObservation(
        {
          code: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("ps: diagnostic\n"),
        },
        123,
        bundleRoot,
      ),
    ).toThrow("tracked process observation failed");
  });
});

describe("packaged storage release", () => {
  it("does not restore the keychain or remove scratch while a process remains live", async () => {
    const restoreKeychain = vi.fn(async () => true);
    const removeScratch = vi.fn(async () => undefined);

    await expect(
      releaseAcceptanceStorage({
        processesStopped: false,
        debuggerListenersClosed: true,
        recoveryPath: "/tmp/recovery.keychain-db",
        restoreKeychain,
        removeScratch,
      }),
    ).rejects.toThrow("acceptance storage retained");
    expect(restoreKeychain).not.toHaveBeenCalled();
    expect(removeScratch).not.toHaveBeenCalled();
  });

  it("does not remove scratch when keychain restoration is not proven", async () => {
    const removeScratch = vi.fn(async () => undefined);

    await expect(
      releaseAcceptanceStorage({
        processesStopped: true,
        debuggerListenersClosed: true,
        recoveryPath: "/tmp/recovery.keychain-db",
        restoreKeychain: async () => false,
        removeScratch,
      }),
    ).rejects.toThrow("acceptance keychain retained");
    expect(removeScratch).not.toHaveBeenCalled();
  });
});
