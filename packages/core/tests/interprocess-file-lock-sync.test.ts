import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InterprocessFileLockClaimError,
  InterprocessFileLockTimeoutError,
  withInterprocessFileLock,
  withInterprocessFileLockSync,
} from "../src/io/interprocess-file-lock-sync.js";

const tempDirs: string[] = [];

function freshLockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "core-file-lock-"));
  tempDirs.push(directory);
  return join(directory, ".auth-profiles.lock");
}

function claim(pid: number, nonce: string, createdAt = "1998-01-01T00:00:00.000Z"): string {
  return `${JSON.stringify({ version: 1, pid, nonce, createdAt })}\n`;
}

function markerName(nonce: string): string {
  return `owner-${createHash("sha256").update(nonce).digest("hex")}.json`;
}

function markerPath(lockPath: string, nonce: string): string {
  return join(lockPath, markerName(nonce));
}

function publishClaim(
  lockPath: string,
  pid: number,
  nonce: string,
  options: { directoryMode?: number; markerMode?: number } = {},
): string {
  mkdirSync(lockPath, { mode: options.directoryMode ?? 0o700 });
  const path = markerPath(lockPath, nonce);
  writeFileSync(path, claim(pid, nonce), { mode: options.markerMode ?? 0o600 });
  return path;
}

function readOnlyClaim(lockPath: string): Record<string, unknown> {
  const entries = readdirSync(lockPath);
  expect(entries).toHaveLength(1);
  return JSON.parse(readFileSync(join(lockPath, entries[0]!), "utf8")) as Record<string, unknown>;
}

function removePublishedClaim(lockPath: string): void {
  for (const entry of readdirSync(lockPath)) unlinkSync(join(lockPath, entry));
  rmdirSync(lockPath);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("interprocess file lock", () => {
  it("publishes a complete private owner marker before running the action", () => {
    const lockPath = freshLockPath();
    let observed: unknown;

    withInterprocessFileLockSync(
      lockPath,
      () => {
        observed = readOnlyClaim(lockPath);
        expect(statSync(lockPath).isDirectory()).toBe(true);
        expect(statSync(lockPath).mode & 0o777).toBe(0o700);
        expect(statSync(markerPath(lockPath, "synthetic-owner-nonce")).mode & 0o777).toBe(0o600);
      },
      {
        nonce: () => "synthetic-owner-nonce",
        timestamp: () => "1998-02-03T04:05:06.000Z",
      },
    );

    expect(observed).toEqual({
      version: 1,
      pid: process.pid,
      nonce: "synthetic-owner-nonce",
      createdAt: "1998-02-03T04:05:06.000Z",
    });
    expect(() => statSync(lockPath)).toThrow();
    expect(readdirSync(join(lockPath, ".."))).toEqual([]);
  });

  it("bounds a synchronous wait for a live holder at exactly two seconds", () => {
    const lockPath = freshLockPath();
    const originalPath = publishClaim(lockPath, 42_001, "live-owner");
    const original = readFileSync(originalPath, "utf8");
    let elapsed = 0;
    const waits: number[] = [];

    expect(() =>
      withInterprocessFileLockSync(lockPath, () => {}, {
        now: () => elapsed,
        pidStatus: () => "live",
        sleepSync(milliseconds) {
          waits.push(milliseconds);
          elapsed += milliseconds;
        },
      }),
    ).toThrow(InterprocessFileLockTimeoutError);

    expect(elapsed).toBe(2_000);
    expect(waits.every((milliseconds) => milliseconds === 25)).toBe(true);
    expect(readFileSync(originalPath, "utf8")).toBe(original);
    expect(readdirSync(join(lockPath, "..")).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("treats EPERM from the PID probe as a live owner", () => {
    const lockPath = freshLockPath();
    const originalPath = publishClaim(lockPath, 42_002, "protected-owner");
    const denied = Object.assign(new Error("synthetic permission denial"), { code: "EPERM" });
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw denied;
    });
    let elapsed = 0;

    expect(() =>
      withInterprocessFileLockSync(lockPath, () => {}, {
        now: () => elapsed,
        sleepSync(milliseconds) {
          elapsed += milliseconds;
        },
      }),
    ).toThrow(InterprocessFileLockTimeoutError);
    expect(readFileSync(originalPath, "utf8")).toBe(claim(42_002, "protected-owner"));
  });

  it("reclaims a marker published by a definitely dead owner", () => {
    const lockPath = freshLockPath();
    publishClaim(lockPath, 42_003, "dead-owner");
    let actionClaim: unknown;

    withInterprocessFileLockSync(
      lockPath,
      () => {
        actionClaim = readOnlyClaim(lockPath);
      },
      {
        nonce: () => "successor-owner",
        pidStatus: (pid) => (pid === 42_003 ? "dead" : "live"),
      },
    );

    expect(actionClaim).toMatchObject({ pid: process.pid, nonce: "successor-owner" });
    expect(() => statSync(lockPath)).toThrow();
  });

  it("recovers an empty provisional lock directory", () => {
    const lockPath = freshLockPath();
    mkdirSync(lockPath, { mode: 0o700 });
    let actionRan = false;

    withInterprocessFileLockSync(lockPath, () => {
      actionRan = true;
    });

    expect(actionRan).toBe(true);
    expect(() => statSync(lockPath)).toThrow();
  });

  it("fails closed on a malformed marker without changing its bytes", () => {
    const lockPath = freshLockPath();
    mkdirSync(lockPath, { mode: 0o700 });
    const path = join(lockPath, markerName("malformed-owner"));
    const malformed = "not-json{{\nprivate-token-marker";
    writeFileSync(path, malformed, { mode: 0o600 });

    expect(() => withInterprocessFileLockSync(lockPath, () => {})).toThrow(
      InterprocessFileLockClaimError,
    );
    expect(readFileSync(path, "utf8")).toBe(malformed);
  });

  it("fails closed on an invalid UTF-8 marker without changing its bytes", () => {
    const lockPath = freshLockPath();
    mkdirSync(lockPath, { mode: 0o700 });
    const decodedNonce = "invalid-\uFFFD-owner";
    const path = join(lockPath, markerName(decodedNonce));
    const invalidUtf8Claim = Buffer.concat([
      Buffer.from('{"version":1,"pid":42013,"nonce":"invalid-'),
      Buffer.from([0x80]),
      Buffer.from('","createdAt":"1998-01-01T00:00:00.000Z"}\n'),
    ]);
    writeFileSync(path, invalidUtf8Claim, { mode: 0o600 });
    let actionRan = false;

    expect(() =>
      withInterprocessFileLockSync(
        lockPath,
        () => {
          actionRan = true;
        },
        {
          nonce: () => "invalid-utf8-successor",
          pidStatus: (pid) => (pid === 42_013 ? "dead" : "live"),
        },
      ),
    ).toThrow(InterprocessFileLockClaimError);
    expect(actionRan).toBe(false);
    expect(readdirSync(lockPath)).toEqual([markerName(decodedNonce)]);
    expect(readFileSync(path)).toEqual(invalidUtf8Claim);
  });

  it("fails closed when the reusable public lock path is not a directory", () => {
    const lockPath = freshLockPath();
    const malformed = "not-a-lock-directory";
    writeFileSync(lockPath, malformed, { mode: 0o600 });

    expect(() => withInterprocessFileLockSync(lockPath, () => {})).toThrow(
      InterprocessFileLockClaimError,
    );
    expect(readFileSync(lockPath, "utf8")).toBe(malformed);
  });

  it("preserves a successor published between exact-marker release and directory removal", () => {
    const lockPath = freshLockPath();
    const successor = claim(42_004, "release-successor");

    withInterprocessFileLockSync(lockPath, () => {}, {
      afterReleaseMarkerRemoved(path) {
        rmdirSync(path);
        mkdirSync(path, { mode: 0o700 });
        writeFileSync(markerPath(path, "release-successor"), successor, { mode: 0o600 });
      },
    });

    expect(readFileSync(markerPath(lockPath, "release-successor"), "utf8")).toBe(successor);
    expect(statSync(lockPath).isDirectory()).toBe(true);
  });

  it("fails closed when its nonce marker changes before the action", () => {
    const lockPath = freshLockPath();
    let actionRan = false;

    expect(() =>
      withInterprocessFileLockSync(
        lockPath,
        () => {
          actionRan = true;
        },
        {
          afterClaimPublished(path) {
            const [entry] = readdirSync(path);
            if (entry === undefined) throw new Error("Expected owner marker");
            writeFileSync(join(path, entry), claim(42_006, "changed-owner"), { mode: 0o600 });
          },
        },
      ),
    ).toThrow(InterprocessFileLockClaimError);
    expect(actionRan).toBe(false);
    expect(statSync(lockPath).isDirectory()).toBe(true);
  });

  it("fails closed when an unexpected extra owner marker appears before the action", () => {
    const lockPath = freshLockPath();
    let actionRan = false;
    let elapsed = 0;

    expect(() =>
      withInterprocessFileLockSync(
        lockPath,
        () => {
          actionRan = true;
        },
        {
          nonce: () => "expected-owner",
          now: () => elapsed,
          pidStatus: () => "live",
          sleepSync(milliseconds) {
            elapsed += milliseconds;
          },
          afterClaimPublished(path) {
            writeFileSync(
              markerPath(path, "unexpected-owner"),
              claim(process.pid, "unexpected-owner"),
              { mode: 0o600 },
            );
          },
        },
      ),
    ).toThrow(InterprocessFileLockTimeoutError);
    expect(actionRan).toBe(false);
    expect(readdirSync(lockPath)).toEqual([markerName("unexpected-owner")]);
    expect(readOnlyClaim(lockPath)).toMatchObject({ nonce: "unexpected-owner" });
  });

  it("retries when a contender removes the provisional directory during publication", () => {
    const lockPath = freshLockPath();
    let publications = 0;
    let actionRan = false;

    withInterprocessFileLockSync(
      lockPath,
      () => {
        actionRan = true;
      },
      {
        nonce: () => `creator-${publications}`,
        afterClaimPublished(path) {
          publications += 1;
          if (publications !== 1) return;
          removePublishedClaim(path);
          mkdirSync(path, { mode: 0o700 });
        },
      },
    );

    expect(publications).toBe(2);
    expect(actionRan).toBe(true);
    expect(() => statSync(lockPath)).toThrow();
  });

  it("retries when its exact provisional marker disappears from the same directory", () => {
    const lockPath = freshLockPath();
    let publications = 0;
    let actionRan = false;

    withInterprocessFileLockSync(
      lockPath,
      () => {
        actionRan = true;
      },
      {
        nonce: () => `marker-owner-${publications}`,
        afterClaimPublished(path) {
          publications += 1;
          if (publications !== 1) return;
          const [entry] = readdirSync(path);
          if (entry === undefined) throw new Error("Expected owner marker");
          unlinkSync(join(path, entry));
        },
      },
    );

    expect(publications).toBe(2);
    expect(actionRan).toBe(true);
    expect(() => statSync(lockPath)).toThrow();
  });

  it("cleans up an exact published marker after a post-publication failure", () => {
    const lockPath = freshLockPath();
    const failure = new Error("synthetic post-publication failure");

    expect(() =>
      withInterprocessFileLockSync(lockPath, () => {}, {
        nonce: () => "failed-published-owner",
        afterClaimPublished() {
          throw failure;
        },
      }),
    ).toThrow(failure);
    expect(() => statSync(lockPath)).toThrow();
    expect(() =>
      withInterprocessFileLockSync(lockPath, () => {}, {
        nonce: () => "subsequent-owner",
      }),
    ).not.toThrow();
    expect(readdirSync(join(lockPath, ".."))).toEqual([]);
  });

  it("keeps strict directory and marker permissions on POSIX platforms", () => {
    const lockPath = freshLockPath();
    publishClaim(lockPath, 42_011, "broad-posix-permissions", {
      directoryMode: 0o755,
      markerMode: 0o644,
    });

    expect(() => withInterprocessFileLockSync(lockPath, () => {}, { platform: "linux" })).toThrow(
      InterprocessFileLockClaimError,
    );
  });

  it("accepts a regular marker when Windows cannot represent POSIX mode bits", () => {
    const lockPath = freshLockPath();
    publishClaim(lockPath, 42_012, "windows-owner", {
      directoryMode: 0o755,
      markerMode: 0o644,
    });
    let actionRan = false;

    withInterprocessFileLockSync(
      lockPath,
      () => {
        actionRan = true;
      },
      {
        platform: "win32",
        pidStatus: (pid) => (pid === 42_012 ? "dead" : "live"),
        nonce: () => "windows-successor",
      },
    );

    expect(actionRan).toBe(true);
    expect(() => statSync(lockPath)).toThrow();
  });

  it("does not delete a live successor when two reclaimers observe the same dead marker", async () => {
    const lockPath = freshLockPath();
    publishClaim(lockPath, 42_007, "observed-dead");
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let second: Promise<void> | undefined;
    let activeActions = 0;
    let maximumActiveActions = 0;
    const writes: string[] = [];

    await withInterprocessFileLock(
      lockPath,
      async () => {
        activeActions += 1;
        maximumActiveActions = Math.max(maximumActiveActions, activeActions);
        writes.push("first");
        activeActions -= 1;
      },
      {
        nonce: () => "first-reclaimer",
        pid: 42_101,
        pidStatus: (pid) => (pid === 42_007 ? "dead" : "live"),
        afterDeadClaimVerified() {
          if (second !== undefined) return;
          second = withInterprocessFileLock(
            lockPath,
            async () => {
              activeActions += 1;
              maximumActiveActions = Math.max(maximumActiveActions, activeActions);
              writes.push("second");
              await secondGate;
              activeActions -= 1;
            },
            {
              nonce: () => "second-reclaimer",
              pid: 42_102,
              pidStatus: (pid) => (pid === 42_007 ? "dead" : "live"),
            },
          );
        },
        async delay() {
          expect(readOnlyClaim(lockPath)).toMatchObject({
            pid: 42_102,
            nonce: "second-reclaimer",
          });
          releaseSecond();
          await second;
        },
      },
    );

    await second;
    expect(writes).toEqual(["second", "first"]);
    expect(maximumActiveActions).toBe(1);
    expect(() => statSync(lockPath)).toThrow();
  });

  it("cleans up its marker, directory, and temp file when the action throws", () => {
    const lockPath = freshLockPath();
    const failure = new Error("synthetic action failure");

    expect(() =>
      withInterprocessFileLockSync(lockPath, () => {
        throw failure;
      }),
    ).toThrow(failure);
    expect(readdirSync(join(lockPath, ".."))).toEqual([]);
  });

  it("waits asynchronously and acquires after the holder releases", async () => {
    const lockPath = freshLockPath();
    publishClaim(lockPath, 42_009, "async-holder");
    let elapsed = 0;
    let actionRan = false;

    await withInterprocessFileLock(
      lockPath,
      () => {
        actionRan = true;
      },
      {
        now: () => elapsed,
        pidStatus: () => "live",
        async delay(milliseconds) {
          elapsed += milliseconds;
          if (elapsed === 50) removePublishedClaim(lockPath);
        },
      },
    );

    expect(elapsed).toBe(50);
    expect(actionRan).toBe(true);
    expect(readdirSync(join(lockPath, ".."))).toEqual([]);
  });

  it("holds the lock until an asynchronous action settles", async () => {
    const lockPath = freshLockPath();
    let releaseFirst!: () => void;
    let releaseRetry!: () => void;
    let markFirstEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      markFirstEntered = resolve;
    });
    const first = withInterprocessFileLock(lockPath, async () => {
      markFirstEntered();
      await firstGate;
    });
    await firstEntered;
    let secondRan = false;
    const delay = vi.fn(async () => retryGate);
    const second = withInterprocessFileLock(
      lockPath,
      () => {
        secondRan = true;
      },
      { delay, pidStatus: () => "live" },
    );
    await vi.waitFor(() => expect(delay).toHaveBeenCalledOnce());

    expect(secondRan).toBe(false);
    expect(statSync(lockPath).isDirectory()).toBe(true);
    releaseFirst();
    await first;
    releaseRetry();
    await second;

    expect(secondRan).toBe(true);
    expect(() => statSync(lockPath)).toThrow();
  });

  it("bounds an asynchronous wait at exactly two seconds", async () => {
    const lockPath = freshLockPath();
    const originalPath = publishClaim(lockPath, 42_010, "async-live-holder");
    const original = readFileSync(originalPath, "utf8");
    let elapsed = 0;

    await expect(
      withInterprocessFileLock(lockPath, () => {}, {
        now: () => elapsed,
        pidStatus: () => "live",
        async delay(milliseconds) {
          elapsed += milliseconds;
        },
      }),
    ).rejects.toBeInstanceOf(InterprocessFileLockTimeoutError);
    expect(elapsed).toBe(2_000);
    expect(readFileSync(originalPath, "utf8")).toBe(original);
  });

  it("does not enter when its exact marker is replaced without changing the directory", () => {
    const lockPath = freshLockPath();
    let actionRan = false;

    expect(() =>
      withInterprocessFileLockSync(
        lockPath,
        () => {
          actionRan = true;
        },
        {
          afterClaimPublished(path) {
            const [entry] = readdirSync(path);
            if (entry === undefined) throw new Error("Expected owner marker");
            unlinkSync(join(path, entry));
            writeFileSync(join(path, entry), claim(process.pid, "different-nonce"), {
              mode: 0o600,
            });
          },
        },
      ),
    ).toThrow(InterprocessFileLockClaimError);
    expect(actionRan).toBe(false);
  });
});
