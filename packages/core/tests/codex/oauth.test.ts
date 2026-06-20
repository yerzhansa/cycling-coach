import { describe, it, expect, afterEach, vi } from "vitest";
import { refreshCodexToken, generatePKCE } from "../../src/agent/codex/oauth.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

const TOKEN_WITH_ACCOUNT = makeJwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_x" },
});
const TOKEN_WITHOUT_ACCOUNT = makeJwt({ sub: "user_1" });

describe("refreshCodexToken", () => {
  it("returns rotated credentials with an absolute expiry and the decoded accountId", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: TOKEN_WITH_ACCOUNT,
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );

    const before = Date.now();
    const creds = await refreshCodexToken("old-refresh");

    expect(creds.access).toBe(TOKEN_WITH_ACCOUNT);
    expect(creds.refresh).toBe("new-refresh");
    expect(creds.accountId).toBe("acct_x");
    expect(creds.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(creds.expires).toBeLessThanOrEqual(Date.now() + 3600 * 1000);
  });

  it("throws the exact 'Failed to refresh' message on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 400 }));
    await expect(refreshCodexToken("rt")).rejects.toThrow("Failed to refresh OpenAI Codex token");
  });

  it("throws the same message when the fetch itself throws (network)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(refreshCodexToken("rt")).rejects.toThrow("Failed to refresh OpenAI Codex token");
  });

  it("throws when the token response is missing required fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: TOKEN_WITH_ACCOUNT, expires_in: 3600 }), {
        status: 200,
      }),
    );
    await expect(refreshCodexToken("rt")).rejects.toThrow("Failed to refresh OpenAI Codex token");
  });

  it("throws when the token carries no chatgpt_account_id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: TOKEN_WITHOUT_ACCOUNT,
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    await expect(refreshCodexToken("rt")).rejects.toThrow("Failed to extract accountId from token");
  });

  it("never logs the refresh token or response body on failure (redaction)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"error":"super secret server detail"}', { status: 400 }),
    );

    await refreshCodexToken("secret-refresh-token").catch(() => {});

    const logged = errSpy.mock.calls
      .flat()
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    expect(logged).not.toContain("secret-refresh-token");
    expect(logged).not.toContain("super secret server detail");
    // It does log the status code for diagnostics.
    expect(logged).toContain("400");
  });
});

describe("generatePKCE", () => {
  function base64url(bytes: Uint8Array): string {
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  it("produces base64url verifier/challenge that differ per call", async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.verifier).not.toBe(a.challenge);
    expect(a.verifier).not.toBe(b.verifier);
  });

  it("challenge is the base64url SHA-256 of the verifier (S256)", async () => {
    const { verifier, challenge } = await generatePKCE();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    expect(challenge).toBe(base64url(new Uint8Array(digest)));
  });
});
