import { createHash } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareAndSaveStoredProfile,
  deleteStoredProfile,
  loadStoredProfileSnapshot,
  recoverAndSaveStoredProfile,
  saveStoredProfile,
} from "../src/auth/profile-store.js";
import { InterprocessFileLockTimeoutError } from "../src/io/interprocess-file-lock-sync.js";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];
const childFixture = fileURLToPath(
  new URL("./fixtures/profile-store-lock-child.ts", import.meta.url),
);
const profileSaveOrderings: ReadonlyArray<"cas-first" | "save-first"> = ["cas-first", "save-first"];
const reservedProfileNames = ["__proto__", "constructor", "toString"] as const;

function freshProfilesPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "core-profile-store-"));
  tempDirs.push(directory);
  return join(directory, "auth-profiles.json");
}

function profile(access: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    type: "oauth",
    access,
    refresh: `${access}-refresh`,
    expires: 4_102_444_800_000,
  };
}

function invalidUtf8ProfilesBytes(profileName = "alpha"): Buffer {
  return Buffer.concat([
    Buffer.from(`{"${profileName}":{"type":"oauth","access":"invalid-`, "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('","refresh":"invalid-refresh","expires":4102444800000}}', "utf8"),
  ]);
}

function lockMarkerPath(lockPath: string, nonce: string): string {
  const digest = createHash("sha256").update(nonce).digest("hex");
  return join(lockPath, `owner-${digest}.json`);
}

function publishLockClaim(lockPath: string, pid: number, nonce: string): void {
  mkdirSync(lockPath, { mode: 0o700 });
  writeFileSync(
    lockMarkerPath(lockPath, nonce),
    `${JSON.stringify({
      version: 1,
      pid,
      nonce,
      createdAt: "1998-01-01T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
}

function spawnStoreChild(
  mode: "barrier-recovery" | "barrier-writer" | "cas" | "holder" | "writer",
  profilesPath: string,
  readyPath: string,
  releasePath: string,
  profileName = "beta",
  access = "beta-access",
): ChildProcess {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      childFixture,
      mode,
      profilesPath,
      readyPath,
      releasePath,
      profileName,
      access,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
  );
  children.push(child);
  return child;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("Synthetic child barrier timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForChild(child: ChildProcess, allowFailure = false): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!allowFailure && child.exitCode !== 0)
      throw new Error(`Synthetic child exited ${child.exitCode}`);
    return;
  }
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (allowFailure || code === 0) resolve();
      else reject(new Error(`Synthetic child exited ${code ?? signal}: ${stderr}`));
    });
  });
}

afterEach(async () => {
  vi.useRealTimers();
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await waitForChild(child, true);
  }
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("profile store", () => {
  it("atomically deletes one profile while preserving unrelated entries", () => {
    const profilesPath = freshProfilesPath();
    saveStoredProfile(profilesPath, "alpha", profile("alpha"));
    saveStoredProfile(profilesPath, "beta", profile("beta"));

    expect(deleteStoredProfile(profilesPath, "alpha")).toEqual({ status: "deleted" });
    expect(deleteStoredProfile(profilesPath, "alpha")).toEqual({ status: "missing" });
    expect(loadStoredProfileSnapshot(profilesPath, "alpha")).toBeNull();
    expect(loadStoredProfileSnapshot(profilesPath, "beta")).not.toBeNull();
    expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
  });

  it("saves synchronously under the sibling lock and preserves unrelated profiles", () => {
    const profilesPath = freshProfilesPath();
    saveStoredProfile(profilesPath, "alpha", profile("alpha"));
    saveStoredProfile(profilesPath, "beta", profile("beta"));

    const stored = JSON.parse(readFileSync(profilesPath, "utf8"));
    expect(stored).toMatchObject({
      alpha: { access: "alpha" },
      beta: { access: "beta" },
    });
    expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(profilesPath, "..")).sort()).toEqual(["auth-profiles.json"]);
  });

  it.each(reservedProfileNames)(
    "treats the reserved profile name %s as an own key during save and load",
    (name) => {
      const profilesPath = freshProfilesPath();
      saveStoredProfile(profilesPath, "unrelated", profile("unrelated"));

      expect(loadStoredProfileSnapshot(profilesPath, name)).toBeNull();

      saveStoredProfile(profilesPath, name, profile(`${name}-access`));

      const stored = JSON.parse(readFileSync(profilesPath, "utf8")) as Record<string, unknown>;
      expect(Object.hasOwn(stored, name)).toBe(true);
      expect(stored[name]).toMatchObject({ access: `${name}-access` });
      expect(stored.unrelated).toMatchObject({ access: "unrelated" });
      expect(loadStoredProfileSnapshot(profilesPath, name)?.profile).toMatchObject({
        access: `${name}-access`,
      });
    },
  );

  it.each(reservedProfileNames)(
    "compares and saves the reserved profile name %s without inherited-key confusion",
    async (name) => {
      const profilesPath = freshProfilesPath();
      saveStoredProfile(profilesPath, "unrelated", profile("unrelated"));
      const unrelated = loadStoredProfileSnapshot(profilesPath, "unrelated");
      if (unrelated === null) throw new Error("Expected synthetic profile snapshot");
      const beforeMissingCompare = readFileSync(profilesPath);

      await expect(
        compareAndSaveStoredProfile(profilesPath, name, unrelated, profile("not-saved")),
      ).resolves.toEqual({ status: "missing" });
      expect(readFileSync(profilesPath)).toEqual(beforeMissingCompare);

      saveStoredProfile(profilesPath, name, profile("original"));
      const expected = loadStoredProfileSnapshot(profilesPath, name);
      if (expected === null) throw new Error("Expected synthetic profile snapshot");

      await expect(
        compareAndSaveStoredProfile(profilesPath, name, expected, profile("replacement")),
      ).resolves.toMatchObject({ status: "saved", profile: { access: "replacement" } });
      await expect(
        compareAndSaveStoredProfile(profilesPath, name, expected, profile("stale")),
      ).resolves.toMatchObject({
        status: "superseded",
        profile: { access: "replacement" },
      });

      const stored = JSON.parse(readFileSync(profilesPath, "utf8")) as Record<string, unknown>;
      expect(Object.hasOwn(stored, name)).toBe(true);
      expect(stored[name]).toMatchObject({ access: "replacement" });
      expect(stored.unrelated).toMatchObject({ access: "unrelated" });
    },
  );

  it.each(reservedProfileNames)(
    "salvages reserved profile keys and replaces reserved target %s during recovery",
    (name) => {
      const profilesPath = freshProfilesPath();
      const originalDocument = Object.fromEntries([
        ...reservedProfileNames.map(
          (reservedName) => [reservedName, profile(`${reservedName}-original`)] as const,
        ),
        ["unrelated", profile("unrelated")],
        ["invalid", "opaque-child"],
      ]);
      const originalBytes = Buffer.from(JSON.stringify(originalDocument), "utf8");
      writeFileSync(profilesPath, originalBytes, { mode: 0o600 });

      recoverAndSaveStoredProfile(profilesPath, name, profile(`${name}-replacement`));

      const stored = JSON.parse(readFileSync(profilesPath, "utf8")) as Record<string, unknown>;
      for (const reservedName of reservedProfileNames) {
        expect(Object.hasOwn(stored, reservedName)).toBe(true);
        expect(stored[reservedName]).toMatchObject({
          access:
            reservedName === name ? `${reservedName}-replacement` : `${reservedName}-original`,
        });
      }
      expect(stored.unrelated).toMatchObject({ access: "unrelated" });
      expect(Object.hasOwn(stored, "invalid")).toBe(false);
      expect(readFileSync(`${profilesPath}.corrupt`)).toEqual(originalBytes);
    },
  );

  it("compares the complete raw profile, including future optional fields", async () => {
    const profilesPath = freshProfilesPath();
    saveStoredProfile(
      profilesPath,
      "alpha",
      profile("original", { future: { generation: 1, enabled: true } }),
    );
    const expected = loadStoredProfileSnapshot(profilesPath, "alpha");
    expect(expected).not.toBeNull();
    if (expected === null) throw new Error("Expected synthetic profile snapshot");

    saveStoredProfile(
      profilesPath,
      "alpha",
      profile("original", { future: { generation: 2, enabled: true } }),
    );
    const currentBytes = readFileSync(profilesPath, "utf8");
    const result = await compareAndSaveStoredProfile(
      profilesPath,
      "alpha",
      expected,
      profile("stale-result"),
    );

    expect(result).toMatchObject({
      status: "superseded",
      profile: { access: "original", future: { generation: 2, enabled: true } },
    });
    expect(readFileSync(profilesPath, "utf8")).toBe(currentBytes);
  });

  it("preserves malformed profile bytes when synchronous save cannot read them", () => {
    const profilesPath = freshProfilesPath();
    const originalBytes = "{malformed-profile-document\n";
    writeFileSync(profilesPath, originalBytes, { mode: 0o600 });

    expect(() => saveStoredProfile(profilesPath, "alpha", profile("replacement"))).toThrow(
      SyntaxError,
    );
    expect(readFileSync(profilesPath, "utf8")).toBe(originalBytes);
  });

  it("fails closed without mutating invalid UTF-8 during load, save, or compare-and-save", async () => {
    const profilesPath = freshProfilesPath();
    saveStoredProfile(profilesPath, "alpha", profile("original"));
    const expected = loadStoredProfileSnapshot(profilesPath, "alpha");
    if (expected === null) throw new Error("Expected synthetic profile snapshot");
    const originalBytes = invalidUtf8ProfilesBytes();
    writeFileSync(profilesPath, originalBytes, { mode: 0o600 });

    expect(() => loadStoredProfileSnapshot(profilesPath, "alpha")).toThrow(TypeError);
    expect(readFileSync(profilesPath)).toEqual(originalBytes);
    expect(() => saveStoredProfile(profilesPath, "alpha", profile("replacement"))).toThrow(
      TypeError,
    );
    expect(readFileSync(profilesPath)).toEqual(originalBytes);
    await expect(
      compareAndSaveStoredProfile(profilesPath, "alpha", expected, profile("replacement")),
    ).rejects.toThrow(TypeError);
    expect(readFileSync(profilesPath)).toEqual(originalBytes);
  });

  it("recovers invalid UTF-8 regular-file bytes into a private quarantine", () => {
    const profilesPath = freshProfilesPath();
    const originalBytes = invalidUtf8ProfilesBytes();
    writeFileSync(profilesPath, originalBytes, { mode: 0o644 });

    recoverAndSaveStoredProfile(profilesPath, "alpha", profile("replacement"));

    const quarantinePath = `${profilesPath}.corrupt`;
    expect(readFileSync(quarantinePath)).toEqual(originalBytes);
    expect(statSync(quarantinePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(profilesPath, "utf8"))).toMatchObject({
      alpha: { access: "replacement" },
    });
    expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
  });

  it("salvages valid unrelated entries while quarantining an invalid child", () => {
    const profilesPath = freshProfilesPath();
    const originalBytes = JSON.stringify({
      retained: profile("retained"),
      invalid: "opaque-child",
    });
    writeFileSync(profilesPath, originalBytes, { mode: 0o600 });

    recoverAndSaveStoredProfile(profilesPath, "alpha", profile("replacement"));

    expect(JSON.parse(readFileSync(profilesPath, "utf8"))).toMatchObject({
      retained: { access: "retained" },
      alpha: { access: "replacement" },
    });
    expect(readFileSync(`${profilesPath}.corrupt`, "utf8")).toBe(originalBytes);
  });

  it("retains the malformed active file when the replacement write fails", () => {
    const profilesPath = freshProfilesPath();
    const originalBytes = "not-json{{\n";
    writeFileSync(profilesPath, originalBytes, { mode: 0o600 });

    expect(() =>
      recoverAndSaveStoredProfile(profilesPath, "alpha", {
        ...profile("replacement"),
        unsupported: 1n,
      }),
    ).toThrow(TypeError);

    expect(readFileSync(profilesPath, "utf8")).toBe(originalBytes);
    expect(readFileSync(`${profilesPath}.corrupt`, "utf8")).toBe(originalBytes);
    expect(statSync(`${profilesPath}.corrupt`).mode & 0o777).toBe(0o600);
  });

  it("uses collision-safe quarantine names across repeated recoveries", () => {
    const profilesPath = freshProfilesPath();
    const firstBytes = "first-malformed{{";
    const secondBytes = "second-malformed{{";
    writeFileSync(profilesPath, firstBytes, { mode: 0o600 });
    recoverAndSaveStoredProfile(profilesPath, "alpha", profile("first"));
    writeFileSync(profilesPath, secondBytes, { mode: 0o600 });
    recoverAndSaveStoredProfile(profilesPath, "alpha", profile("second"));

    expect(readFileSync(`${profilesPath}.corrupt`, "utf8")).toBe(firstBytes);
    expect(readFileSync(`${profilesPath}.corrupt.1`, "utf8")).toBe(secondBytes);
    expect(statSync(`${profilesPath}.corrupt`).mode & 0o777).toBe(0o600);
    expect(statSync(`${profilesPath}.corrupt.1`).mode & 0o777).toBe(0o600);
  });

  it("preserves an invalid root when compare-and-save cannot decode it", async () => {
    const profilesPath = freshProfilesPath();
    saveStoredProfile(profilesPath, "alpha", profile("original"));
    const expected = loadStoredProfileSnapshot(profilesPath, "alpha");
    if (expected === null) throw new Error("Expected synthetic profile snapshot");
    const originalBytes = JSON.stringify([profile("unrelated")]);
    writeFileSync(profilesPath, originalBytes, { mode: 0o600 });

    await expect(
      compareAndSaveStoredProfile(profilesPath, "alpha", expected, profile("replacement")),
    ).rejects.toThrow("OAuth profiles document must be a map.");
    expect(readFileSync(profilesPath, "utf8")).toBe(originalBytes);
  });

  it("preserves an invalid child entry instead of dropping it during save", () => {
    const profilesPath = freshProfilesPath();
    const originalBytes = JSON.stringify({ alpha: profile("original"), future: "opaque" });
    writeFileSync(profilesPath, originalBytes, { mode: 0o600 });

    expect(() => saveStoredProfile(profilesPath, "beta", profile("replacement"))).toThrow(
      "OAuth profile entries must be maps.",
    );
    expect(readFileSync(profilesPath, "utf8")).toBe(originalBytes);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "preserves a regular profile file when permissions deny reading it",
    () => {
      const profilesPath = freshProfilesPath();
      const originalBytes = JSON.stringify({ alpha: profile("original") });
      writeFileSync(profilesPath, originalBytes, { mode: 0o600 });
      chmodSync(profilesPath, 0o000);
      try {
        expect(() => saveStoredProfile(profilesPath, "beta", profile("replacement"))).toThrow();
      } finally {
        chmodSync(profilesPath, 0o600);
      }
      expect(readFileSync(profilesPath, "utf8")).toBe(originalBytes);
    },
  );

  it("refuses recovery when the active profile path is not a regular file", () => {
    const profilesPath = freshProfilesPath();
    mkdirSync(profilesPath, { mode: 0o700 });

    expect(() =>
      recoverAndSaveStoredProfile(profilesPath, "alpha", profile("replacement")),
    ).toThrow("OAuth profiles recovery requires a regular file.");
    expect(statSync(profilesPath).isDirectory()).toBe(true);
    expect(existsSync(`${profilesPath}.corrupt`)).toBe(false);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "does not quarantine or overwrite a profile file when reading is denied",
    () => {
      const profilesPath = freshProfilesPath();
      const originalBytes = "not-json{{\n";
      writeFileSync(profilesPath, originalBytes, { mode: 0o600 });
      chmodSync(profilesPath, 0o000);
      try {
        expect(() =>
          recoverAndSaveStoredProfile(profilesPath, "alpha", profile("replacement")),
        ).toThrow();
        expect(existsSync(`${profilesPath}.corrupt`)).toBe(false);
      } finally {
        chmodSync(profilesPath, 0o600);
      }
      expect(readFileSync(profilesPath, "utf8")).toBe(originalBytes);
    },
  );

  it("does not quarantine or overwrite a profile file after an I/O read error", async () => {
    const profilesPath = freshProfilesPath();
    const originalBytes = "not-json{{\n";
    writeFileSync(profilesPath, originalBytes, { mode: 0o600 });
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        readFileSync(path: Parameters<typeof actual.readFileSync>[0], ...args: unknown[]) {
          if (path === profilesPath) {
            throw Object.assign(new Error("synthetic I/O read failure"), { code: "EIO" });
          }
          return Reflect.apply(actual.readFileSync, actual, [path, ...args]);
        },
      };
    });
    try {
      const profileStore = await import("../src/auth/profile-store.js");
      expect(() =>
        profileStore.recoverAndSaveStoredProfile(profilesPath, "alpha", profile("replacement")),
      ).toThrow(expect.objectContaining({ code: "EIO" }));
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
    expect(readFileSync(profilesPath, "utf8")).toBe(originalBytes);
    expect(existsSync(`${profilesPath}.corrupt`)).toBe(false);
  });

  it("returns missing without recreating a deleted profile", async () => {
    const profilesPath = freshProfilesPath();
    saveStoredProfile(profilesPath, "alpha", profile("original"));
    const expected = loadStoredProfileSnapshot(profilesPath, "alpha");
    if (expected === null) throw new Error("Expected synthetic profile snapshot");
    rmSync(profilesPath);

    await expect(
      compareAndSaveStoredProfile(profilesPath, "alpha", expected, profile("stale-result")),
    ).resolves.toEqual({ status: "missing" });
    expect(existsSync(profilesPath)).toBe(false);
  });

  it.each(profileSaveOrderings)(
    "preserves distinct profile keys in the %s ordering",
    async (ordering) => {
      const profilesPath = freshProfilesPath();
      saveStoredProfile(profilesPath, "alpha", profile("alpha-original"));
      const expected = loadStoredProfileSnapshot(profilesPath, "alpha");
      if (expected === null) throw new Error("Expected synthetic profile snapshot");

      if (ordering === "cas-first") {
        await compareAndSaveStoredProfile(
          profilesPath,
          "alpha",
          expected,
          profile("alpha-rotated"),
        );
        saveStoredProfile(profilesPath, "beta", profile("beta-login"));
      } else {
        saveStoredProfile(profilesPath, "beta", profile("beta-login"));
        await compareAndSaveStoredProfile(
          profilesPath,
          "alpha",
          expected,
          profile("alpha-rotated"),
        );
      }

      expect(JSON.parse(readFileSync(profilesPath, "utf8"))).toMatchObject({
        alpha: { access: "alpha-rotated" },
        beta: { access: "beta-login" },
      });
      expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
    },
  );

  it("leaves the profile bytes unchanged when the writer lock times out", async () => {
    const profilesPath = freshProfilesPath();
    saveStoredProfile(profilesPath, "alpha", profile("original"));
    const expected = loadStoredProfileSnapshot(profilesPath, "alpha");
    if (expected === null) throw new Error("Expected synthetic profile snapshot");
    const originalBytes = readFileSync(profilesPath, "utf8");
    const lockPath = join(profilesPath, "..", ".auth-profiles.lock");
    publishLockClaim(lockPath, process.pid, "live-profile-store-holder");

    vi.useFakeTimers();
    const settled = compareAndSaveStoredProfile(
      profilesPath,
      "alpha",
      expected,
      profile("must-not-persist"),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_000);

    const error = await settled;
    expect(error).toBeInstanceOf(InterprocessFileLockTimeoutError);
    expect(error).not.toMatchObject({
      message: expect.stringMatching(/original|must-not-persist|refresh/u),
    });
    expect(readFileSync(profilesPath, "utf8")).toBe(originalBytes);
  });

  it("serializes real child-process writers without losing either profile", async () => {
    const profilesPath = freshProfilesPath();
    const directory = join(profilesPath, "..");
    const holderReady = join(directory, "holder-ready");
    const writerReady = join(directory, "writer-ready");
    const release = join(directory, "release-holder");
    const holder = spawnStoreChild("holder", profilesPath, holderReady, release);
    await waitForPath(holderReady);
    const writer = spawnStoreChild("writer", profilesPath, writerReady, release);
    await waitForPath(writerReady);
    writeFileSync(release, "release\n", { mode: 0o600 });

    await Promise.all([waitForChild(holder), waitForChild(writer)]);

    expect(JSON.parse(readFileSync(profilesPath, "utf8"))).toMatchObject({
      alpha: { access: "alpha-access" },
      beta: { access: "beta-access" },
    });
    expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(directory, ".auth-profiles.lock"))).toBe(false);
    expect(readdirSync(directory).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("recovers a real child-process claim after SIGKILL", async () => {
    const profilesPath = freshProfilesPath();
    const directory = join(profilesPath, "..");
    const holderReady = join(directory, "holder-ready");
    const release = join(directory, "never-release-holder");
    const holder = spawnStoreChild("holder", profilesPath, holderReady, release);
    await waitForPath(holderReady);
    expect(holder.kill("SIGKILL")).toBe(true);
    await waitForChild(holder, true);
    expect(existsSync(join(directory, ".auth-profiles.lock"))).toBe(true);

    const writerReady = join(directory, "writer-ready");
    const writer = spawnStoreChild("writer", profilesPath, writerReady, release);
    await waitForChild(writer);

    expect(JSON.parse(readFileSync(profilesPath, "utf8"))).toMatchObject({
      beta: { access: "beta-access" },
    });
    expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(directory, ".auth-profiles.lock"))).toBe(false);
  });

  it("serializes two real child-process reclaimers after the same holder dies", async () => {
    const profilesPath = freshProfilesPath();
    const directory = join(profilesPath, "..");
    const holderReady = join(directory, "holder-ready");
    const release = join(directory, "never-release-holder");
    const holder = spawnStoreChild("holder", profilesPath, holderReady, release);
    await waitForPath(holderReady);
    expect(holder.kill("SIGKILL")).toBe(true);
    await waitForChild(holder, true);

    const firstReady = join(directory, "first-writer-ready");
    const secondReady = join(directory, "second-writer-ready");
    const first = spawnStoreChild(
      "writer",
      profilesPath,
      firstReady,
      release,
      "first-provider",
      "first-access",
    );
    const second = spawnStoreChild(
      "writer",
      profilesPath,
      secondReady,
      release,
      "second-provider",
      "second-access",
    );
    await Promise.all([waitForPath(firstReady), waitForPath(secondReady)]);
    await Promise.all([waitForChild(first), waitForChild(second)]);

    expect(JSON.parse(readFileSync(profilesPath, "utf8"))).toMatchObject({
      "first-provider": { access: "first-access" },
      "second-provider": { access: "second-access" },
    });
    expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
    expect(existsSync(join(directory, ".auth-profiles.lock"))).toBe(false);
    expect(readdirSync(directory).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  it("preserves a newer real child-process login against a stale CAS result", async () => {
    const profilesPath = freshProfilesPath();
    saveStoredProfile(profilesPath, "openai-codex", profile("original"));
    const directory = join(profilesPath, "..");
    const casReady = join(directory, "cas-ready");
    const releaseCas = join(directory, "release-cas");
    const cas = spawnStoreChild(
      "cas",
      profilesPath,
      casReady,
      releaseCas,
      "openai-codex",
      "stale-refresh-result",
    );
    await waitForPath(casReady);

    const loginReady = join(directory, "login-ready");
    const login = spawnStoreChild(
      "writer",
      profilesPath,
      loginReady,
      releaseCas,
      "openai-codex",
      "new-login",
    );
    await waitForChild(login);
    writeFileSync(releaseCas, "release\n", { mode: 0o600 });
    await waitForChild(cas);

    expect(JSON.parse(readFileSync(profilesPath, "utf8"))).toMatchObject({
      "openai-codex": { access: "new-login" },
    });
    expect(JSON.parse(readFileSync(`${casReady}.result`, "utf8"))).toMatchObject({
      status: "superseded",
      profile: { access: "new-login" },
    });
  });

  it("serializes concurrent recovery and ordinary writer processes without overwriting bytes", async () => {
    const profilesPath = freshProfilesPath();
    const originalBytes = "not-json{{\nconcurrent-recovery-marker";
    writeFileSync(profilesPath, originalBytes, { mode: 0o600 });
    const directory = join(profilesPath, "..");
    const start = join(directory, "start-concurrent-writers");
    const recoveryReady = join(directory, "recovery-ready");
    const writerReady = join(directory, "ordinary-writer-ready");
    const recovery = spawnStoreChild(
      "barrier-recovery",
      profilesPath,
      recoveryReady,
      start,
      "recovered-provider",
      "recovered-access",
    );
    const writer = spawnStoreChild(
      "barrier-writer",
      profilesPath,
      writerReady,
      start,
      "ordinary-provider",
      "ordinary-access",
    );
    await Promise.all([waitForPath(recoveryReady), waitForPath(writerReady)]);
    writeFileSync(start, "start\n", { mode: 0o600 });
    await Promise.all([waitForChild(recovery), waitForChild(writer, true)]);
    if (writer.exitCode !== 0) {
      const retryReady = join(directory, "ordinary-writer-retry-ready");
      const retry = spawnStoreChild(
        "writer",
        profilesPath,
        retryReady,
        start,
        "ordinary-provider",
        "ordinary-access",
      );
      await waitForChild(retry);
    }

    expect(readFileSync(`${profilesPath}.corrupt`, "utf8")).toBe(originalBytes);
    expect(JSON.parse(readFileSync(profilesPath, "utf8"))).toMatchObject({
      "recovered-provider": { access: "recovered-access" },
      "ordinary-provider": { access: "ordinary-access" },
    });
    expect(statSync(`${profilesPath}.corrupt`).mode & 0o777).toBe(0o600);
    expect(statSync(profilesPath).mode & 0o777).toBe(0o600);
  });
});
