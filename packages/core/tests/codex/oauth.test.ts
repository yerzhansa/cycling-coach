import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  CodexLoginError,
  loginCodex,
  refreshCodexToken,
  generatePKCE,
  type CodexLoginOptions,
} from "../../src/agent/codex/oauth.js";
import { RefreshTokenReusedError } from "../../src/auth/profiles.js";
import { classifyFailure } from "../../src/agent/token-utils.js";

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
  it("tags an explicit invalid grant as reauthentication without the profile wrapper", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );

    const error = await refreshCodexToken("").catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: "TokenRefreshError",
      refreshFailureReason: "reauth",
    });
    expect(error).not.toBeInstanceOf(RefreshTokenReusedError);
    expect(classifyFailure(error)).toBe("reauth");
  });

  it.each([
    ["invalid_grant", 400, { error: "invalid_grant" }],
    ["invalid_token", 401, { error: { code: "invalid_token" } }],
    ["expired_token", 403, { error: "expired_token" }],
    ["revoked_token", 400, { error: { code: "revoked_token" } }],
    ["refresh_token_expired", 400, { error: "refresh_token_expired" }],
    ["refresh_token_revoked", 400, { error: { code: "refresh_token_revoked" } }],
  ])("classifies the explicit %s OAuth code as reauthentication", async (_code, status, body) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));

    const error = await refreshCodexToken("synthetic-refresh").catch((failure: unknown) => failure);

    expect(error).toMatchObject({ refreshFailureReason: "reauth" });
    expect(classifyFailure(error)).toBe("reauth");
  });

  it.each([
    [401, undefined, "unknown"],
    [403, undefined, "unknown"],
    [499, undefined, "unknown"],
    [400, { error: "invalid_client" }, "unknown"],
    [400, { error: { code: "unsupported_grant_type" } }, "unknown"],
    [429, { error: "invalid_grant" }, "rate_limit"],
    [500, { error: "invalid_grant" }, "server_error"],
  ] as const)(
    "classifies HTTP %s without credential-rejection proof structurally",
    async (status, body, expected) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(body === undefined ? null : JSON.stringify(body), { status }),
      );

      const error = await refreshCodexToken("synthetic-refresh").catch(
        (failure: unknown) => failure,
      );

      expect(error).toMatchObject({ refreshFailureReason: expected });
      expect(classifyFailure(error)).toBe(expected);
      expect(error).not.toBeInstanceOf(RefreshTokenReusedError);
    },
  );

  it.each([
    [500, "server_error"],
    [501, "server_error"],
    [599, "server_error"],
  ] as const)("keeps HTTP %s refresh failures retryable", async (status, expected) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status }));

    const error = await refreshCodexToken("").catch((failure: unknown) => failure);

    expect(error).not.toBeInstanceOf(RefreshTokenReusedError);
    expect(error).toMatchObject({
      name: "TokenRefreshError",
      refreshFailureReason: expected,
    });
    expect(classifyFailure(error)).toBe(expected);
  });

  it("keeps a fetch failure retryable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));

    const error = await refreshCodexToken("").catch((failure: unknown) => failure);

    expect(error).not.toBeInstanceOf(RefreshTokenReusedError);
    expect(error).toMatchObject({
      name: "TokenRefreshError",
      refreshFailureReason: "network",
    });
    expect((error as Error).name).not.toBe("NetworkError");
    expect(classifyFailure(error)).toBe("network");
  });

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

  it("classifies an unrecognized non-OK response as unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 400 }));
    await expect(refreshCodexToken("rt")).rejects.toMatchObject({
      name: "TokenRefreshError",
      refreshFailureReason: "unknown",
    });
  });

  it("classifies a fetch rejection as network without the bridge retry marker", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(refreshCodexToken("rt")).rejects.toMatchObject({
      name: "TokenRefreshError",
      refreshFailureReason: "network",
    });
  });

  it("classifies a token response missing required fields as unknown", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: TOKEN_WITH_ACCOUNT, expires_in: 3600 }), {
        status: 200,
      }),
    );
    await expect(refreshCodexToken("rt")).rejects.toMatchObject({
      refreshFailureReason: "unknown",
    });
  });

  it("classifies malformed success JSON as unknown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{", { status: 200, headers: { "content-type": "application/json" } }),
    );

    await expect(refreshCodexToken("rt")).rejects.toMatchObject({
      refreshFailureReason: "unknown",
    });
  });

  it("classifies malformed failure JSON as unknown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{", { status: 400, headers: { "content-type": "application/json" } }),
    );

    await expect(refreshCodexToken("rt")).rejects.toMatchObject({
      refreshFailureReason: "unknown",
    });
  });

  it.each([null, [], "synthetic", 7, true])(
    "classifies valid non-object success JSON %# as unknown",
    async (body) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

      await expect(refreshCodexToken("synthetic-refresh")).rejects.toMatchObject({
        refreshFailureReason: "unknown",
      });
    },
  );

  it("rethrows an abort from failure-body decoding unchanged", async () => {
    const abort = new DOMException("Cancelled", "AbortError");
    const response = new Response("{}", { status: 400 });
    vi.spyOn(response, "json").mockRejectedValue(abort);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(refreshCodexToken("synthetic-refresh")).rejects.toBe(abort);
  });

  it("rethrows an abort from success-body decoding unchanged", async () => {
    const abort = new DOMException("Cancelled", "AbortError");
    const response = new Response("{}", { status: 200 });
    vi.spyOn(response, "json").mockRejectedValue(abort);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(refreshCodexToken("synthetic-refresh")).rejects.toBe(abort);
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

  it("propagates the abort instead of relabeling when the caller signal fires", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // A token endpoint that never responds on its own; the only way the promise
    // settles is the passed-in abort signal firing.
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const sig = init?.signal;
        if (!sig) return; // never settles without a signal -> proves we thread one
        if (sig.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        sig.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const controller = new AbortController();
    const pending = refreshCodexToken("rt", controller.signal);
    // Fire the deadline; the in-flight token refresh must unwind, not hang.
    controller.abort();

    const err = await pending.catch((e) => e);
    expect((err as Error).name).toBe("AbortError");
    expect((err as Error).message).not.toMatch(/Failed to refresh/);
  });

  it("propagates the 30s backstop TimeoutError instead of relabeling", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    });

    const err = await refreshCodexToken("rt").catch((e) => e);
    expect((err as Error).name).toBe("TimeoutError");
    expect((err as Error).message).not.toMatch(/Failed to refresh/);
    expect(err).not.toBeInstanceOf(RefreshTokenReusedError);
    expect(classifyFailure(err)).toBe("timeout");
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

describe("loginCodex", () => {
  it("keeps manual-code login available when another callback listener owns the port", async () => {
    const foreignServer = createServer((_request, response) => {
      response.end("foreign listener");
    });
    await new Promise<void>((resolve, reject) => {
      foreignServer.once("error", reject);
      foreignServer.listen(1455, "127.0.0.1", () => {
        foreignServer.off("error", reject);
        resolve();
      });
    });

    try {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: TOKEN_WITH_ACCOUNT,
            refresh_token: "obviously-fake-port-collision-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
      let authorizationInfo: Parameters<CodexLoginOptions["onAuth"]>[0] | undefined;
      const onPrompt = vi.fn(async () => "unexpected-prompt-input");

      const credentials = await loginCodex({
        onAuth: (info) => {
          authorizationInfo = info;
        },
        onManualCodeInput: async () => "obviously-fake-port-collision-code",
        onPrompt,
      });

      expect(authorizationInfo).toMatchObject({
        url: expect.stringMatching(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/),
        callbackAvailable: false,
      });
      expect(onPrompt).not.toHaveBeenCalled();
      expect(credentials).toMatchObject({
        access: TOKEN_WITH_ACCOUNT,
        refresh: "obviously-fake-port-collision-refresh",
        accountId: "acct_x",
      });
      expect(foreignServer.listening).toBe(true);
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        "[codex-oauth] Failed to bind http://127.0.0.1:1455 (",
        "EADDRINUSE",
        ") Falling back to manual paste.",
      );
      const logged = errorSpy.mock.calls.flat().join(" ");
      expect(logged).not.toContain("obviously-fake-port-collision-code");
      expect(logged).not.toContain("obviously-fake-port-collision-refresh");
      expect(logged).not.toContain(TOKEN_WITH_ACCOUNT);
    } finally {
      await new Promise<void>((resolve, reject) => {
        foreignServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("bounds stalled manual and fallback prompts when the callback port is unavailable", async () => {
    const foreignServer = createServer((_request, response) => {
      response.end("foreign listener");
    });
    await new Promise<void>((resolve, reject) => {
      foreignServer.once("error", reject);
      foreignServer.listen(1455, "127.0.0.1", () => {
        foreignServer.off("error", reject);
        resolve();
      });
    });

    try {
      vi.spyOn(console, "error").mockImplementation(() => {});
      let stalledManualSignal: AbortSignal | undefined;
      let stalledFallbackSignal: AbortSignal | undefined;
      const fallbackPrompt = vi.fn((prompt: { signal: AbortSignal }) => {
        stalledFallbackSignal = prompt.signal;
        return new Promise<string>(() => {});
      });
      const stalledManual = loginCodex({
        authorizationTimeoutMs: 5,
        onAuth: () => {},
        onManualCodeInput: (signal) => {
          stalledManualSignal = signal;
          return new Promise<string>(() => {});
        },
        onPrompt: fallbackPrompt,
      });
      await expect(stalledManual).rejects.toMatchObject({
        reason: "authorization-timed-out",
      });
      expect(fallbackPrompt).not.toHaveBeenCalled();
      expect(stalledManualSignal?.aborted).toBe(true);

      const stalledFallback = loginCodex({
        authorizationTimeoutMs: 5,
        onAuth: () => {},
        onPrompt: fallbackPrompt,
      });
      await expect(stalledFallback).rejects.toMatchObject({
        reason: "authorization-timed-out",
      });
      expect(fallbackPrompt).toHaveBeenCalledOnce();
      expect(stalledFallbackSignal?.aborted).toBe(true);

      const caller = new AbortController();
      const callerCancelled = loginCodex({
        authorizationTimeoutMs: 5_000,
        signal: caller.signal,
        onAuth: () => {},
        onPrompt: () => {
          caller.abort(new DOMException("Cancelled", "AbortError"));
          return new Promise<string>(() => {});
        },
      });
      await expect(callerCancelled).rejects.toMatchObject({ name: "AbortError" });
      expect(foreignServer.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        foreignServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("aborts the callback wait and releases the registered port", async () => {
    const controller = new AbortController();
    const pending = loginCodex({
      signal: controller.signal,
      onAuth: () => controller.abort(new DOMException("Cancelled", "AbortError")),
      onPrompt: async () => "",
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(1455, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("classifies the bounded browser wait separately and releases the callback port", async () => {
    const error = await loginCodex({
      authorizationTimeoutMs: 5,
      onAuth: () => {},
      onPrompt: async () => "",
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(CodexLoginError);
    expect(error).toMatchObject({ reason: "authorization-timed-out" });

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(1455, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("forces callback shutdown past an incomplete keep-alive connection within one second", async () => {
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: TOKEN_WITH_ACCOUNT,
          refresh_token: "obviously-fake-bounded-close-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      ),
    );
    let heldSocket: Socket | undefined;
    let callback: Promise<Response> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const startedAt = Date.now();
      const pending = loginCodex({
        onAuth: ({ url }) => {
          const state = new URL(url).searchParams.get("state");
          heldSocket = createConnection({ host: "127.0.0.1", port: 1455 }, () => {
            callback = nativeFetch(
              `http://127.0.0.1:1455/auth/callback?code=obviously-fake-bounded-close-code&state=${state}`,
            );
          });
        },
        onPrompt: async () => "",
      });
      const deadlinePromise = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error("OAuth callback shutdown exceeded 1s")),
          1_000,
        );
      });

      await expect(Promise.race([pending, deadlinePromise])).resolves.toMatchObject({
        accountId: "acct_x",
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      await expect(callback).resolves.toBeInstanceOf(Response);

      const rebound = createServer();
      await new Promise<void>((resolve, reject) => {
        rebound.once("error", reject);
        rebound.listen(1455, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve) => rebound.close(() => resolve()));
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
      heldSocket?.destroy();
      await callback?.catch(() => undefined);
    }
  });

  it("gives token exchange a fresh deadline when browser authorization finishes at 4:59", async () => {
    const nativeFetch = globalThis.fetch;
    const authorizationDeadline = new AbortController();
    const exchangeDeadline = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementationOnce((ms) => {
        expect(ms).toBe(5 * 60 * 1000);
        return authorizationDeadline.signal;
      })
      .mockImplementationOnce((ms) => {
        expect(ms).toBe(10_000);
        return exchangeDeadline.signal;
      });
    let releaseExchange!: () => void;
    let exchangeStarted!: () => void;
    const exchangeStart = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    const tokenFetch = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      expect(init?.signal).toBe(exchangeDeadline.signal);
      exchangeStarted();
      return new Promise<Response>((resolve, reject) => {
        releaseExchange = () =>
          resolve(
            new Response(
              JSON.stringify({
                access_token: TOKEN_WITH_ACCOUNT,
                refresh_token: "obviously-fake-fresh-deadline-refresh",
                expires_in: 3600,
              }),
              { status: 200 },
            ),
          );
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const phases: string[] = [];
    let callback: Promise<Response> | undefined;

    const pending = loginCodex({
      onAuth: ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        callback = nativeFetch(
          `http://127.0.0.1:1455/auth/callback?code=obviously-fake-fresh-deadline-code&state=${state}`,
        );
      },
      onPrompt: async () => "",
      onProgress: (phase) => phases.push(phase),
    });
    await exchangeStart;

    // This represents the original five-minute browser deadline firing just
    // after a callback at 4:59. It must no longer be connected to exchange.
    authorizationDeadline.abort(new DOMException("Timed out", "TimeoutError"));
    expect(exchangeDeadline.signal.aborted).toBe(false);
    releaseExchange();

    await expect(pending).resolves.toMatchObject({ accountId: "acct_x" });
    await expect(callback).resolves.toBeInstanceOf(Response);
    expect(phases).toEqual(["waiting-for-browser", "completing-sign-in"]);
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(tokenFetch).toHaveBeenCalledOnce();
  });

  it("aborts a stalled token exchange at its own deadline without retrying the code", async () => {
    const nativeFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    let callback: Promise<Response> | undefined;

    const error = await loginCodex({
      tokenExchangeTimeoutMs: 10,
      onAuth: ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        callback = nativeFetch(
          `http://127.0.0.1:1455/auth/callback?code=obviously-fake-timeout-code&state=${state}`,
        );
      },
      onPrompt: async () => "",
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(CodexLoginError);
    expect(error).toMatchObject({ reason: "token-exchange-timed-out" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    await expect(callback).resolves.toBeInstanceOf(Response);

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(1455, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("keeps exchange errors and diagnostics free of the authorization code and endpoint detail", async () => {
    const nativeFetch = globalThis.fetch;
    const authorizationCode = "obviously-fake-private-authorization-code";
    const endpointDetail = "obviously-fake-private-endpoint-detail";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError(endpointDetail));
    let callback: Promise<Response> | undefined;

    const error = await loginCodex({
      onAuth: ({ url }) => {
        const state = new URL(url).searchParams.get("state");
        callback = nativeFetch(
          `http://127.0.0.1:1455/auth/callback?code=${authorizationCode}&state=${state}`,
        );
      },
      onPrompt: async () => "",
    }).catch((failure: unknown) => failure);
    await expect(callback).resolves.toBeInstanceOf(Response);

    expect(error).toBeInstanceOf(CodexLoginError);
    expect(error).toMatchObject({ reason: "token-exchange-failed" });
    const exposed = `${String(error)} ${errorSpy.mock.calls.flat().join(" ")}`;
    expect(exposed).not.toContain(authorizationCode);
    expect(exposed).not.toContain(endpointDetail);
  });

  it("requires a new state and PKCE challenge after an exchange failure", async () => {
    const nativeFetch = globalThis.fetch;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tokenFetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: TOKEN_WITH_ACCOUNT,
            refresh_token: "obviously-fake-retry-refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      );
    const authorizationUrls: string[] = [];
    const callbacks: Promise<Response>[] = [];
    const run = () =>
      loginCodex({
        onAuth: ({ url }) => {
          authorizationUrls.push(url);
          const state = new URL(url).searchParams.get("state");
          callbacks.push(
            nativeFetch(
              `http://127.0.0.1:1455/auth/callback?code=obviously-fake-retry-code-${authorizationUrls.length}&state=${state}`,
            ),
          );
        },
        onPrompt: async () => "",
      });

    await expect(run()).rejects.toMatchObject({ reason: "token-exchange-failed" });
    await expect(run()).resolves.toMatchObject({ accountId: "acct_x" });
    await Promise.all(callbacks);

    const first = new URL(authorizationUrls[0]!);
    const second = new URL(authorizationUrls[1]!);
    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
    expect(first.searchParams.get("code_challenge")).not.toBe(
      second.searchParams.get("code_challenge"),
    );
    expect(tokenFetch).toHaveBeenCalledTimes(2);
  });

  it("completes the localhost callback and fake token exchange", async () => {
    const nativeFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("http://127.0.0.1:1455/")) return nativeFetch(input, init);
      return new Response(
        JSON.stringify({
          access_token: TOKEN_WITH_ACCOUNT,
          refresh_token: "obviously-fake-refresh",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    let callback: Promise<Response> | undefined;
    const phases: string[] = [];
    let manualInputSignal: AbortSignal | undefined;
    const credentials = await loginCodex({
      onAuth: ({ url, callbackAvailable }) => {
        expect(callbackAvailable).toBe(true);
        const state = new URL(url).searchParams.get("state");
        callback = nativeFetch(
          `http://127.0.0.1:1455/auth/callback?code=obviously-fake-code&state=${state}`,
        );
      },
      onPrompt: async () => "",
      onManualCodeInput: (signal) => {
        manualInputSignal = signal;
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      onProgress: (phase) => phases.push(phase),
    });
    if (!callback) throw new Error("Expected the OAuth callback request to start");
    const callbackResponse = await callback;
    expect(callbackResponse.headers.get("connection")).toBe("close");
    expect(phases).toEqual(["waiting-for-browser", "completing-sign-in"]);
    expect(manualInputSignal?.aborted).toBe(true);
    expect(credentials).toMatchObject({
      access: TOKEN_WITH_ACCOUNT,
      refresh: "obviously-fake-refresh",
      accountId: "acct_x",
    });
  });
});
