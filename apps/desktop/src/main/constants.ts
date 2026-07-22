export const DESKTOP_SCHEME = "enduragent" as const;
export const DESKTOP_HOST = "app" as const;
export const DESKTOP_RENDERER_ORIGIN = "enduragent://app" as const;
export const DESKTOP_RENDERER_URL = "enduragent://app/index.html" as const;
export const DESKTOP_CONNECTION_CHANNEL = "desktop:get-daemon-connection" as const;
export const DESKTOP_LIFECYCLE_CHANNEL = "desktop:daemon-lifecycle" as const;
export const DESKTOP_OPEN_EXTERNAL_CHANNEL = "desktop:open-external" as const;
export const DESKTOP_WINDOW_WIDTH = 1_180 as const;
export const DESKTOP_WINDOW_HEIGHT = 820 as const;
export const DESKTOP_WINDOW_MIN_WIDTH = 760 as const;
export const DESKTOP_WINDOW_MIN_HEIGHT = 600 as const;
export const UTILITY_EXIT_TIMEOUT_MS = 5_000 as const;
export const UTILITY_FORCE_EXIT_TIMEOUT_MS = 2_000 as const;
export const UTILITY_SPAWN_TIMEOUT_MS = 5_000 as const;
export const UTILITY_TERMINAL_ACK_TIMEOUT_MS = 1_000 as const;

export function createDesktopContentSecurityPolicy(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("invalid daemon port");
  }
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ws://127.0.0.1:${port}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
}
