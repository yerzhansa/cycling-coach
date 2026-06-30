import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { extractAccountId } from "./jwt.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPE = "openid profile email offline_access";
const CALLBACK_PORT = 1455;
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/auth/callback";
const TOKEN_REFRESH_TIMEOUT_MS = 30_000;

export interface CodexCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
  /** Reserved; never populated by this module. */
  email?: string;
}

export interface CodexLoginOptions {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
}

// ============================================================================
// PKCE
// ============================================================================

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));
  return { verifier, challenge };
}

// ============================================================================
// Callback page (minimal inline HTML)
// ============================================================================

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function successHtml(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authentication successful</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px;"><h1>Authentication successful</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function errorHtml(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Authentication failed</title></head><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px;"><h1>Authentication failed</h1><p>${escapeHtml(message)}</p></body></html>`;
}

// ============================================================================
// Authorization flow
// ============================================================================

function createState(): string {
  return randomBytes(16).toString("hex");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    // not a URL
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

async function createAuthorizationFlow(
  originator = "pi",
): Promise<{ verifier: string; state: string; url: string }> {
  const { verifier, challenge } = await generatePKCE();
  const state = createState();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", originator);
  return { verifier, state, url: url.toString() };
}

interface OAuthServerHandle {
  close: () => void;
  cancelWait: () => void;
  waitForCode: () => Promise<{ code: string } | null>;
}

function startLocalOAuthServer(state: string): Promise<OAuthServerHandle> {
  let settleWait: ((value: { code: string } | null) => void) | undefined;
  const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
    let settled = false;
    settleWait = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  const server: Server = createServer((req, res) => {
    const respond = (status: number, html: string) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
    };
    try {
      const url = new URL(req.url || "", "http://localhost");
      if (url.pathname !== CALLBACK_PATH) {
        respond(404, errorHtml("Callback route not found."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        respond(400, errorHtml("State mismatch."));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        respond(400, errorHtml("Missing authorization code."));
        return;
      }
      respond(200, successHtml("OpenAI authentication completed. You can close this window."));
      settleWait?.({ code });
    } catch {
      respond(500, errorHtml("Internal error while processing OAuth callback."));
    }
  });

  return new Promise<OAuthServerHandle>((resolve) => {
    server
      .listen(CALLBACK_PORT, CALLBACK_HOST, () => {
        resolve({
          close: () => server.close(),
          cancelWait: () => settleWait?.(null),
          waitForCode: () => waitForCodePromise,
        });
      })
      .on("error", (err: NodeJS.ErrnoException) => {
        console.error(
          "[codex-oauth] Failed to bind http://127.0.0.1:1455 (",
          err.code,
          ") Falling back to manual paste.",
        );
        settleWait?.(null);
        resolve({
          close: () => {
            try {
              server.close();
            } catch {
              // ignore
            }
          },
          cancelWait: () => {},
          waitForCode: async () => null,
        });
      });
  });
}

// ============================================================================
// Token endpoint (redaction-critical: never log response bodies or tokens)
// ============================================================================

type TokenResult =
  | { type: "success"; access: string; refresh: string; expires: number }
  | { type: "failed" };

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string = REDIRECT_URI,
): Promise<TokenResult> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }),
  });
  if (!response.ok) {
    console.error("[codex-oauth] code->token failed:", response.status);
    return { type: "failed" };
  }
  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    console.error("[codex-oauth] token response missing fields:", {
      hasAccessToken: !!json.access_token,
      hasRefreshToken: !!json.refresh_token,
      hasExpiresIn: typeof json.expires_in === "number",
    });
    return { type: "failed" };
  }
  return {
    type: "success",
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

function isAbortShaped(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

async function refreshAccessToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<TokenResult> {
  try {
    // The token endpoint should respond quickly; bound it with a short timeout
    // combined with the caller's deadline so a stall can't hang the turn.
    const timeout = AbortSignal.timeout(TOKEN_REFRESH_TIMEOUT_MS);
    const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
      signal: fetchSignal,
    });
    if (!response.ok) {
      console.error("[codex-oauth] Token refresh failed:", response.status);
      return { type: "failed" };
    }
    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
      console.error("[codex-oauth] Token refresh response missing fields:", {
        hasAccessToken: !!json.access_token,
        hasRefreshToken: !!json.refresh_token,
        hasExpiresIn: typeof json.expires_in === "number",
      });
      return { type: "failed" };
    }
    return {
      type: "success",
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    };
  } catch (error) {
    // A deadline or 30s-backstop abort is not a credential failure -- propagate it
    // with its real shape so the retry/deny path is skipped and the surfaced error
    // is the abort, not a misleading "re-run setup".
    if (isAbortShaped(error) || signal?.aborted) throw error;
    console.error("[codex-oauth] Token refresh error:", error);
    return { type: "failed" };
  }
}

// ============================================================================
// Public API
// ============================================================================

export async function loginCodex(options: CodexLoginOptions): Promise<CodexCredentials> {
  const { verifier, state, url } = await createAuthorizationFlow(options.originator);
  const server = await startLocalOAuthServer(state);
  options.onAuth({ url, instructions: "A browser window should open. Complete login to finish." });

  let code: string | undefined;
  const applyParsedInput = (input: string) => {
    const parsed = parseAuthorizationInput(input);
    if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
    code = parsed.code;
  };
  try {
    if (options.onManualCodeInput) {
      // Race the browser callback against manual paste — first to yield a code wins.
      let manualCode: string | undefined;
      let manualError: Error | undefined;
      const manualPromise = options
        .onManualCodeInput()
        .then((input) => {
          manualCode = input;
          server.cancelWait();
        })
        .catch((err) => {
          manualError = err instanceof Error ? err : new Error(String(err));
          server.cancelWait();
        });

      const result = await server.waitForCode();
      if (manualError) throw manualError;
      if (result?.code) {
        code = result.code;
      } else if (manualCode) {
        applyParsedInput(manualCode);
      }
      if (!code) {
        await manualPromise;
        if (manualError) throw manualError;
        if (manualCode) {
          applyParsedInput(manualCode);
        }
      }
    } else {
      const result = await server.waitForCode();
      if (result?.code) code = result.code;
    }

    if (!code) {
      const input = await options.onPrompt({
        message: "Paste the authorization code (or full redirect URL):",
      });
      applyParsedInput(input);
    }

    if (!code) throw new Error("Missing authorization code");

    const tokenResult = await exchangeAuthorizationCode(code, verifier);
    if (tokenResult.type !== "success") throw new Error("Token exchange failed");

    const accountId = extractAccountId(tokenResult.access);

    return {
      access: tokenResult.access,
      refresh: tokenResult.refresh,
      expires: tokenResult.expires,
      accountId,
    };
  } finally {
    server.close();
  }
}

export async function refreshCodexToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<CodexCredentials> {
  const result = await refreshAccessToken(refreshToken, signal);
  if (result.type !== "success") {
    throw new Error("Failed to refresh OpenAI Codex token");
  }
  const accountId = extractAccountId(result.access);
  return {
    access: result.access,
    refresh: result.refresh,
    expires: result.expires,
    accountId,
  };
}
