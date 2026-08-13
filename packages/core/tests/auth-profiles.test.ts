import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { RefreshFailureReason } from "../src/auth/refresh-failure.js";
import type { OAuthCredential } from "../src/auth/profiles.js";

// Redirect $HOME so the profile file lands in a temp dir.
let tempHome: string;
let origHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "cc-auth-"));
  origHome = process.env.HOME;
  process.env.HOME = tempHome;
  vi.resetModules();
});

afterEach(() => {
  process.env.HOME = origHome;
  rmSync(tempHome, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function profilesPath(): string {
  return join(homedir(), ".cycling-coach", "auth-profiles.json");
}

function invalidUtf8ProfilesBytes(): Buffer {
  return Buffer.concat([
    Buffer.from('{"openai-codex":{"type":"oauth","access":"invalid-', "utf8"),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('","refresh":"invalid-refresh","expires":4102444800000}}', "utf8"),
  ]);
}

async function loadModule() {
  const mod = await import("../src/auth/profiles.js");
  return mod;
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve = (_value: T | PromiseLike<T>): void => {
    throw new Error("Deferred promise was not initialized");
  };
  let reject = (_reason?: unknown): void => {
    throw new Error("Deferred promise was not initialized");
  };
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function refreshFailure(reason: RefreshFailureReason): Error & {
  readonly refreshFailureReason: RefreshFailureReason;
} {
  return Object.assign(new Error("Synthetic refresh failure"), {
    name: "TokenRefreshError",
    refreshFailureReason: reason,
  });
}

const nonReauthFailureReasons: ReadonlyArray<Exclude<RefreshFailureReason, "reauth">> = [
  "server_error",
  "network",
  "rate_limit",
  "unknown",
];

describe("auth/profiles", () => {
  it("loadProfile returns null when file is missing", async () => {
    const { loadProfile } = await loadModule();
    expect(loadProfile("openai-codex")).toBeNull();
  });

  it("saveProfile writes 0o600 file and loadProfile returns the saved data", async () => {
    // Parent directory is created by loadConfig usually — create here, BEFORE
    // loadModule(): config.ts captures CONFIG_DIR at module load, and
    // getCoachHome's tier-2 (legacy `~/.cycling-coach/`) only fires when that
    // directory exists at the call site.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const { saveProfile, loadProfile } = await loadModule();
    const cred = {
      type: "oauth" as const,
      access: "a",
      refresh: "r",
      expires: Date.now() + 60_000,
      accountId: "acct",
      email: "foo@example.com",
    };
    saveProfile("openai-codex", cred);

    const st = statSync(profilesPath());
    expect(st.mode & 0o777).toBe(0o600);

    const loaded = loadProfile("openai-codex");
    expect(loaded).toEqual(cred);
  });

  it("getFreshToken returns cached access when not near expiry", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "cached-access",
      refresh: "refresh",
      expires: Date.now() + 60 * 60_000,
    });
    const token = await getFreshToken("openai-codex");
    expect(token).toBe("cached-access");
  });

  it("getFreshToken returns stored access when expires is non-finite", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(async () => ({
        access: "new-access",
        refresh: "new-refresh",
        expires: Date.now() + 60 * 60_000,
        accountId: "acct",
      })),
      loginCodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: Number.NaN,
    });
    const token = await getFreshToken("openai-codex");
    expect(token).toBe("old");

    const saved = JSON.parse(readFileSync(profilesPath(), "utf-8"));
    expect(saved["openai-codex"].access).toBe("old");
    expect(saved["openai-codex"].refresh).toBe("old-refresh");
  });

  it("getFreshToken returns stored access when within the former 5-min threshold", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: vi.fn(async () => ({
        access: "rotated",
        refresh: "rotated-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "acct",
      })),
      loginCodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: Date.now() + 2 * 60_000,
    });
    const token = await getFreshToken("openai-codex");
    expect(token).toBe("old");
  });

  it.each([-2, 2])(
    "getFreshToken returns stored access with a %i-hour local clock skew",
    async (skewHours) => {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

      const serverNow = Date.parse("1998-07-18T12:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(serverNow + skewHours * 60 * 60_000);
      const refreshMock = vi.fn();
      vi.doMock("../src/agent/codex/oauth.js", () => ({
        refreshCodexToken: refreshMock,
        loginCodex: vi.fn(),
      }));

      const { saveProfile, getFreshToken } = await loadModule();
      saveProfile("openai-codex", {
        type: "oauth",
        access: "stored-access",
        refresh: "refresh",
        expires: serverNow + 60 * 60_000,
      });

      await expect(getFreshToken("openai-codex")).resolves.toBe("stored-access");
      expect(refreshMock).not.toHaveBeenCalled();
    },
  );

  it("getFreshToken preserves a newer profile when a rejection refresh resolves stale", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const staleRefresh = {
      access: "stale-access",
      refresh: "stale-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "stale-account",
    };
    const pendingRefresh = createDeferred<typeof staleRefresh>();
    const refreshMock = vi.fn().mockReturnValue(pendingRefresh.promise);
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, loadProfile, getFreshToken } = await loadModule();
    const original: OAuthCredential = {
      type: "oauth",
      access: "original-access",
      refresh: "original-refresh",
      expires: Date.now() - 1_000,
      accountId: "original-account",
      email: "original@example.test",
    };
    const newer: OAuthCredential = {
      type: "oauth",
      access: "newer-access",
      refresh: "newer-refresh",
      expires: Date.now() + 7_200_000,
      accountId: "original-account",
      email: "original@example.test",
    };
    saveProfile("openai-codex", original);

    const settled = getFreshToken("openai-codex", undefined, "original-access");
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    saveProfile("openai-codex", newer);
    const newerBytes = readFileSync(profilesPath(), "utf-8");
    pendingRefresh.resolve(staleRefresh);

    expect(await settled).toBe("newer-access");
    expect(loadProfile("openai-codex")).toEqual(newer);
    expect(readFileSync(profilesPath(), "utf-8")).toBe(newerBytes);
    expect(refreshMock).toHaveBeenCalledWith("original-refresh", undefined);
  });

  it("getFreshToken does not resurrect a profile deleted during a rejection refresh", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const staleRefresh = {
      access: "stale-access",
      refresh: "stale-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "stale-account",
    };
    const pendingRefresh = createDeferred<typeof staleRefresh>();
    const refreshMock = vi.fn().mockReturnValue(pendingRefresh.promise);
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, loadProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "original-access",
      refresh: "original-refresh",
      expires: Date.now() - 1_000,
      accountId: "original-account",
      email: "original@example.test",
    });

    const settled = getFreshToken("openai-codex", undefined, "original-access");
    await vi.waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(1));
    unlinkSync(profilesPath());
    pendingRefresh.resolve(staleRefresh);

    await expect(settled).rejects.toThrow('No OAuth profile "openai-codex"');
    expect(existsSync(profilesPath())).toBe(false);
    expect(loadProfile("openai-codex")).toBeNull();
    expect(refreshMock).toHaveBeenCalledWith("original-refresh", undefined);
  });

  it("getFreshToken stops before reauthentication confirmation when the profile was deleted", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const refreshMock = vi.fn().mockImplementationOnce(async () => {
      unlinkSync(profilesPath());
      throw refreshFailure("reauth");
    });
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "original-access",
      refresh: "original-refresh",
      expires: Date.now() - 1_000,
    });

    vi.useFakeTimers();
    const settled = getFreshToken("openai-codex", undefined, "original-access").then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await settled;

    expect(error).toMatchObject({ message: expect.stringContaining("No OAuth profile") });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(existsSync(profilesPath())).toBe(false);
  });

  it("getFreshToken surfaces RefreshTokenReusedError after two reauthentication failures", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const refreshMock = vi.fn(async () => {
      throw refreshFailure("reauth");
    });
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken, RefreshTokenReusedError } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "revoked",
      expires: Date.now() - 1000,
    });

    vi.useFakeTimers();
    const settled = getFreshToken("openai-codex", undefined, "old").then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const error = await settled;
    expect(error).toBeInstanceOf(RefreshTokenReusedError);
    expect(error).toMatchObject({ refreshFailureReason: "reauth" });
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it.each(nonReauthFailureReasons)(
    "getFreshToken propagates a first %s failure without delay or retry",
    async (reason) => {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

      const firstFailure = refreshFailure(reason);
      const refreshMock = vi.fn().mockRejectedValue(firstFailure);
      vi.doMock("../src/agent/codex/oauth.js", () => ({
        refreshCodexToken: refreshMock,
        loginCodex: vi.fn(),
      }));

      const { saveProfile, getFreshToken } = await loadModule();
      saveProfile("openai-codex", {
        type: "oauth",
        access: "old",
        refresh: "synthetic-refresh",
        expires: Date.now() - 1000,
      });

      vi.useFakeTimers();
      const error = await getFreshToken("openai-codex", undefined, "old").then(
        () => null,
        (failure: unknown) => failure,
      );

      expect(error).toBe(firstFailure);
      expect(error).toMatchObject({ refreshFailureReason: reason });
      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(nonReauthFailureReasons)(
    "getFreshToken propagates a %s failure from reauthentication confirmation unchanged",
    async (confirmationReason) => {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

      const confirmationFailure = refreshFailure(confirmationReason);
      const refreshMock = vi
        .fn()
        .mockRejectedValueOnce(refreshFailure("reauth"))
        .mockRejectedValueOnce(confirmationFailure);
      vi.doMock("../src/agent/codex/oauth.js", () => ({
        refreshCodexToken: refreshMock,
        loginCodex: vi.fn(),
      }));

      const { saveProfile, getFreshToken, RefreshTokenReusedError } = await loadModule();
      saveProfile("openai-codex", {
        type: "oauth",
        access: "synthetic-access",
        refresh: "synthetic-refresh",
        expires: Date.now() - 1000,
      });

      vi.useFakeTimers();
      const settled = getFreshToken("openai-codex", undefined, "synthetic-access").then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(2_000);
      const error = await settled;

      expect(error).toBe(confirmationFailure);
      expect(error).toMatchObject({ refreshFailureReason: confirmationReason });
      expect(error).not.toBeInstanceOf(RefreshTokenReusedError);
      expect(refreshMock).toHaveBeenCalledTimes(2);
    },
  );

  it("getFreshToken confirms reauthentication with the current disk token and preserves metadata", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const confirmationExpiry = Date.now() + 3_600_000;
    const refreshMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        writeFileSync(
          profilesPath(),
          JSON.stringify({
            "openai-codex": {
              type: "oauth",
              access: "disk-access",
              refresh: "disk-refresh",
              expires: 0,
              accountId: "disk-account",
              email: "disk@example.test",
            },
          }),
        );
        throw refreshFailure("reauth");
      })
      .mockResolvedValueOnce({
        access: "confirmed-access",
        refresh: "confirmed-refresh",
        expires: confirmationExpiry,
        accountId: "confirmed-account",
      });
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "initial-refresh",
      expires: Date.now() - 1000,
      accountId: "initial-account",
      email: "initial@example.test",
    });

    vi.useFakeTimers();
    const settled = getFreshToken("openai-codex", undefined, "old");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toBe("confirmed-access");
    expect(refreshMock).toHaveBeenCalledTimes(2);
    expect(refreshMock.mock.calls.map(([refreshToken]) => refreshToken)).toEqual([
      "initial-refresh",
      "disk-refresh",
    ]);

    const saved = JSON.parse(readFileSync(profilesPath(), "utf-8"));
    expect(saved["openai-codex"]).toEqual({
      type: "oauth",
      access: "confirmed-access",
      refresh: "confirmed-refresh",
      expires: confirmationExpiry,
      accountId: "confirmed-account",
      email: "disk@example.test",
    });
  });

  it("getFreshToken preserves a newer profile when reauthentication confirmation resolves stale", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const staleConfirmation = {
      access: "stale-confirmed-access",
      refresh: "stale-confirmed-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "stale-confirmed-account",
    };
    const pendingConfirmation = createDeferred<typeof staleConfirmation>();
    const refreshMock = vi
      .fn()
      .mockRejectedValueOnce(refreshFailure("reauth"))
      .mockReturnValueOnce(pendingConfirmation.promise);
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, loadProfile, getFreshToken } = await loadModule();
    const original: OAuthCredential = {
      type: "oauth",
      access: "original-access",
      refresh: "original-refresh",
      expires: Date.now() - 1_000,
      accountId: "original-account",
      email: "original@example.test",
    };
    const newer: OAuthCredential = {
      type: "oauth",
      access: "newer-access",
      refresh: "newer-refresh",
      expires: Date.now() + 7_200_000,
      accountId: "original-account",
      email: "original@example.test",
    };
    saveProfile("openai-codex", original);

    vi.useFakeTimers();
    const settled = getFreshToken("openai-codex", undefined, "original-access");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refreshMock).toHaveBeenCalledTimes(2);
    saveProfile("openai-codex", newer);
    const newerBytes = readFileSync(profilesPath(), "utf-8");
    pendingConfirmation.resolve(staleConfirmation);

    expect(await settled).toBe("newer-access");
    expect(loadProfile("openai-codex")).toEqual(newer);
    expect(readFileSync(profilesPath(), "utf-8")).toBe(newerBytes);
    expect(refreshMock.mock.calls.map(([refreshToken]) => refreshToken)).toEqual([
      "original-refresh",
      "original-refresh",
    ]);
  });

  it("getFreshToken discards a confirmation response when the profile is deleted in flight", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const confirmation = createDeferred<{
      access: string;
      refresh: string;
      expires: number;
      accountId: string;
    }>();
    const refreshMock = vi
      .fn()
      .mockRejectedValueOnce(refreshFailure("reauth"))
      .mockReturnValueOnce(confirmation.promise);
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, loadProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "original-access",
      refresh: "original-refresh",
      expires: Date.now() - 1_000,
    });

    vi.useFakeTimers();
    const settled = getFreshToken("openai-codex", undefined, "original-access").then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(refreshMock).toHaveBeenCalledTimes(2);
    unlinkSync(profilesPath());
    confirmation.resolve({
      access: "discarded-access",
      refresh: "discarded-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "discarded-account",
    });
    const error = await settled;

    expect(error).toMatchObject({ message: expect.stringContaining("No OAuth profile") });
    expect(existsSync(profilesPath())).toBe(false);
    expect(loadProfile("openai-codex")).toBeNull();
  });

  it("getFreshToken commits a successful rotation despite a late abort", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    const controller = new AbortController();
    const lateAbort = new DOMException("Cancelled after endpoint success", "AbortError");
    const refreshMock = vi.fn().mockImplementationOnce(async () => {
      controller.abort(lateAbort);
      return {
        access: "committed-access",
        refresh: "committed-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "committed-account",
      };
    });
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, loadProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "original-access",
      refresh: "original-refresh",
      expires: Date.now() - 1_000,
    });

    await expect(getFreshToken("openai-codex", controller.signal, "original-access")).resolves.toBe(
      "committed-access",
    );
    expect(controller.signal.reason).toBe(lateAbort);
    expect(loadProfile("openai-codex")).toMatchObject({
      access: "committed-access",
      refresh: "committed-refresh",
    });
  });

  it("getFreshToken propagates an ordinary error without delay or retry", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const ordinaryFailure = new Error("Synthetic ordinary failure");
    const refreshMock = vi.fn().mockRejectedValue(ordinaryFailure);
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    });

    vi.useFakeTimers();
    const error = await getFreshToken("openai-codex", undefined, "old").then(
      () => null,
      (failure: unknown) => failure,
    );
    expect(error).toBe(ordinaryFailure);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("getFreshToken preserves an abort that happens before the retry wait", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const pendingRefresh = createDeferred<never>();
    const refreshMock = vi.fn().mockReturnValue(pendingRefresh.promise);
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "synthetic-refresh",
      expires: Date.now() - 1000,
    });

    vi.useFakeTimers();
    const controller = new AbortController();
    const abortError = new DOMException("Cancelled before wait", "AbortError");
    const settled = getFreshToken("openai-codex", controller.signal, "old");
    for (let turn = 0; turn < 10 && refreshMock.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(refreshMock).toHaveBeenCalledTimes(1);
    controller.abort(abortError);
    pendingRefresh.reject(refreshFailure("reauth"));

    await expect(settled).rejects.toBe(abortError);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith("synthetic-refresh", controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("getFreshToken aborts an active retry wait without a second refresh", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const refreshMock = vi.fn().mockRejectedValue(refreshFailure("reauth"));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "synthetic-refresh",
      expires: Date.now() - 1000,
    });

    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const controller = new AbortController();
    const abortError = new DOMException("Cancelled during wait", "AbortError");
    const settled = getFreshToken("openai-codex", controller.signal, "old");
    for (let turn = 0; turn < 10 && vi.getTimerCount() !== 1; turn += 1) {
      await Promise.resolve();
    }
    expect(vi.getTimerCount()).toBe(1);
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_000);
    controller.abort(abortError);

    await expect(settled).rejects.toBe(abortError);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith("synthetic-refresh", controller.signal);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("concurrent getFreshToken calls perform a single refresh", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const refreshMock = vi.fn(async () => ({
      access: "fresh",
      refresh: "fresh-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "acct",
    }));
    vi.doMock("../src/agent/codex/oauth.js", () => ({
      refreshCodexToken: refreshMock,
      loginCodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    });

    const [a, b, c] = await Promise.all([
      getFreshToken("openai-codex", undefined, "old"),
      getFreshToken("openai-codex", undefined, "old"),
      getFreshToken("openai-codex", undefined, "old"),
    ]);
    expect(a).toBe("fresh");
    expect(b).toBe("fresh");
    expect(c).toBe("fresh");
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("saveProfile writes atomically, leaving a single valid 0o600 file", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const { saveProfile, loadProfile } = await loadModule();
    const base = {
      type: "oauth" as const,
      refresh: "r",
      expires: Date.now() + 60_000,
    };
    saveProfile("openai-codex", { ...base, access: "first" });
    saveProfile("openai-codex", { ...base, access: "second" });

    const entries = readdirSync(join(tempHome, ".cycling-coach"));
    expect(entries).toEqual(["auth-profiles.json"]);

    expect(statSync(profilesPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(profilesPath(), "utf-8"))["openai-codex"].access).toBe("second");
    expect(loadProfile("openai-codex")?.access).toBe("second");
  });

  it("returns null without changing a corrupt profiles file", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    writeFileSync(profilesPath(), "not-json{{", { mode: 0o600 });

    const { loadProfile } = await loadModule();
    expect(loadProfile("openai-codex")).toBeNull();
    expect(readFileSync(profilesPath(), "utf8")).toBe("not-json{{");
  });

  it("returns null without changing invalid UTF-8 profile bytes", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    const originalBytes = invalidUtf8ProfilesBytes();
    writeFileSync(profilesPath(), originalBytes, { mode: 0o600 });

    const { loadProfile } = await loadModule();
    expect(loadProfile("openai-codex")).toBeNull();
    expect(readFileSync(profilesPath())).toEqual(originalBytes);
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "does not treat an unreadable profiles file as absent",
    async () => {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
      const originalBytes = JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "unreadable-access",
          refresh: "unreadable-refresh",
          expires: 4_102_444_800_000,
        },
      });
      writeFileSync(profilesPath(), originalBytes, { mode: 0o600 });
      chmodSync(profilesPath(), 0o000);
      try {
        const { loadProfile } = await loadModule();
        expect(() => loadProfile("openai-codex")).toThrow();
      } finally {
        chmodSync(profilesPath(), 0o600);
      }
      expect(readFileSync(profilesPath(), "utf8")).toBe(originalBytes);
      expect(existsSync(`${profilesPath()}.corrupt`)).toBe(false);
    },
  );

  it("recovers invalid UTF-8 profile bytes after a completed login save", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    const originalBytes = invalidUtf8ProfilesBytes();
    writeFileSync(profilesPath(), originalBytes, { mode: 0o600 });

    const { loadProfile, saveProfile } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "replacement-access",
      refresh: "replacement-refresh",
      expires: 4_102_444_800_000,
    });

    expect(loadProfile("openai-codex")).toMatchObject({ access: "replacement-access" });
    expect(readFileSync(`${profilesPath()}.corrupt`)).toEqual(originalBytes);
    expect(statSync(`${profilesPath()}.corrupt`).mode & 0o777).toBe(0o600);
    expect(statSync(profilesPath()).mode & 0o777).toBe(0o600);
  });
});
