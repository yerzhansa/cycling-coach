export const JWT_CLAIM_PATH = "https://api.openai.com/auth";

export interface CodexJwtPayload {
  [JWT_CLAIM_PATH]?: {
    chatgpt_account_id?: unknown;
  };
  [key: string]: unknown;
}

/**
 * Decode the payload (claims) segment of a JWT. Returns null on any malformed
 * input — never throws. Does NOT verify the signature; the token is already
 * trusted (it came from the OAuth token endpoint over TLS).
 */
export function decodeJwt(token: string): CodexJwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const decoded = Buffer.from(parts[1] ?? "", "base64url").toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CodexJwtPayload)
      : null;
  } catch {
    return null;
  }
}

/**
 * Extract chatgpt_account_id from a Codex access token's JWT claims. Returns
 * null if absent, non-string, or empty.
 */
export function getAccountId(accessToken: string): string | null {
  const accountId = decodeJwt(accessToken)?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

/**
 * Like getAccountId but throws when the account id can't be extracted — used by
 * the responses transport, which cannot build the chatgpt-account-id header
 * without it.
 */
export function extractAccountId(accessToken: string): string {
  const accountId = getAccountId(accessToken);
  if (!accountId) throw new Error("Failed to extract accountId from token");
  return accountId;
}
