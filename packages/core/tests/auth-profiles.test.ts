import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from "node:fs";
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
    const { saveProfile, loadProfile } = await loadModule();
    const cred = {
      type: "oauth" as const,
      access: "a",
      refresh: "r",
      expires: Date.now() + 60_000,
      accountId: "acct",
      email: "foo@example.com",
    };
    // Parent directory is created by loadConfig usually — create here.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    saveProfile("openai-codex", cred);

    const st = statSync(profilesPath());
    expect(st.mode & 0o777).toBe(0o600);

    const loaded = loadProfile("openai-codex");
    expect(loaded).toEqual(cred);
  });

  it("getFreshToken returns cached access when not near expiry", async () => {
    const { saveProfile, getFreshToken } = await loadModule();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
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

  it("getFreshToken surfaces RefreshTokenReusedError on refresh failure", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });

    vi.doMock("@mariozechner/pi-ai/oauth", () => ({
      refreshOpenAICodexToken: vi.fn(async () => {
        throw new Error("Failed to refresh OpenAI Codex token");
      }),
      loginOpenAICodex: vi.fn(),
    }));

    const { saveProfile, getFreshToken, RefreshTokenReusedError } = await loadModule();
    saveProfile("openai-codex", {
      type: "oauth",
      access: "old",
      refresh: "revoked",
      expires: Date.now() - 1000,
    });

    await expect(getFreshToken("openai-codex")).rejects.toBeInstanceOf(RefreshTokenReusedError);
  });

  it("survives a corrupt profiles file", async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tempHome, ".cycling-coach"), { recursive: true });
    writeFileSync(profilesPath(), "not-json{{", { mode: 0o600 });

    const { loadProfile } = await loadModule();
    expect(loadProfile("openai-codex")).toBeNull();
  });
});
