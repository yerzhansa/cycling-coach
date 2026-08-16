import { DESKTOP_RENDERER_URL } from "./constants.js";

const NAVIGATION_TOKEN_PARAMETER = "navigationToken";
const NAVIGATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function isDesktopRendererNavigationToken(value: unknown): value is string {
  return typeof value === "string" && NAVIGATION_TOKEN_PATTERN.test(value);
}

export function createDesktopRendererUrl(token: string): string {
  if (!isDesktopRendererNavigationToken(token)) {
    throw new TypeError("invalid desktop renderer navigation token");
  }
  return `${DESKTOP_RENDERER_URL}?${NAVIGATION_TOKEN_PARAMETER}=${token}`;
}

export function desktopRendererNavigationToken(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  const token = parsed.searchParams.get(NAVIGATION_TOKEN_PARAMETER);
  if (
    token === null ||
    parsed.searchParams.size !== 1 ||
    !isDesktopRendererNavigationToken(token) ||
    value !== createDesktopRendererUrl(token)
  ) {
    return undefined;
  }
  return token;
}

export function isDesktopRendererUrl(value: string): boolean {
  return desktopRendererNavigationToken(value) !== undefined;
}
