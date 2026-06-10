import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

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

async function loadModule() {
  const mod = await import("../src/auth/profiles.js");
  return mod;
}

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

  it("getFreshToken refreshes when expires is non-finite", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    vi.doMock("@mariozechner/pi-ai/oauth", () => ({
      refreshOpenAICodexToken: vi.fn(async () => ({
        access: "new-access",
        refresh: "new-refresh",
        expires: Date.now() + 60 * 60_000,
        accountId: "acct",
      })),
      loginOpenAICodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: Number.NaN,
    });
    const token = await getFreshToken("openai-codex");
    expect(token).toBe("new-access");

    const saved = JSON.parse(readFileSync(profilesPath(), "utf-8"));
    expect(saved["openai-codex"].access).toBe("new-access");
    expect(saved["openai-codex"].refresh).toBe("new-refresh");
  });

  it("getFreshToken refreshes when within 5-min threshold", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    vi.doMock("@mariozechner/pi-ai/oauth", () => ({
      refreshOpenAICodexToken: vi.fn(async () => ({
        access: "rotated",
        refresh: "rotated-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "acct",
      })),
      loginOpenAICodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: Date.now() + 2 * 60_000, // 2 min from now — inside threshold
    });
    const token = await getFreshToken("openai-codex");
    expect(token).toBe("rotated");
  });

  it("getFreshToken surfaces RefreshTokenReusedError only after a retry also fails", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const refreshMock = vi.fn(async () => {
      throw new Error("Failed to refresh OpenAI Codex token");
    });
    vi.doMock("@mariozechner/pi-ai/oauth", () => ({
      refreshOpenAICodexToken: refreshMock,
      loginOpenAICodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken, RefreshTokenReusedError } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "revoked",
      expires: Date.now() - 1000,
    });

    vi.useFakeTimers();
    const settled = getFreshToken("openai-codex").then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toBeInstanceOf(RefreshTokenReusedError);
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it("getFreshToken recovers when a transient failure clears on retry", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const refreshMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("Failed to refresh OpenAI Codex token"))
      .mockResolvedValueOnce({
        access: "retry-access",
        refresh: "retry-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "acct",
      });
    vi.doMock("@mariozechner/pi-ai/oauth", () => ({
      refreshOpenAICodexToken: refreshMock,
      loginOpenAICodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    });

    vi.useFakeTimers();
    const settled = getFreshToken("openai-codex");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled).toBe("retry-access");
    expect(refreshMock).toHaveBeenCalledTimes(2);

    const saved = JSON.parse(readFileSync(profilesPath(), "utf-8"));
    expect(saved["openai-codex"].refresh).toBe("retry-refresh");
  });

  it("getFreshToken rethrows timeout-flavored errors untouched", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    const refreshMock = vi.fn(async () => {
      throw new Error("Request timed out");
    });
    vi.doMock("@mariozechner/pi-ai/oauth", () => ({
      refreshOpenAICodexToken: refreshMock,
      loginOpenAICodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken, RefreshTokenReusedError } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    });

    const err = await getFreshToken("openai-codex").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RefreshTokenReusedError);
    expect((err as Error).message).toBe("Request timed out");
    expect(refreshMock).toHaveBeenCalledTimes(1);
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
    vi.doMock("@mariozechner/pi-ai/oauth", () => ({
      refreshOpenAICodexToken: refreshMock,
      loginOpenAICodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "old-refresh",
      expires: Date.now() - 1000,
    });

    const [a, b, c] = await Promise.all([
      getFreshToken("openai-codex"),
      getFreshToken("openai-codex"),
      getFreshToken("openai-codex"),
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
    expect(JSON.parse(readFileSync(profilesPath(), "utf-8"))["openai-codex"].access).toBe(
      "second",
    );
    expect(loadProfile("openai-codex")?.access).toBe("second");
  });

  it("survives a corrupt profiles file", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    writeFileSync(profilesPath(), "not-json{{", { mode: 0o600 });

    const { loadProfile } = await loadModule();
    expect(loadProfile("openai-codex")).toBeNull();
  });
});
