import { createRequire } from "node:module";

const TELEGRAM_BOT_API_ORIGIN = "https://api.telegram.org";
const REQUIRED_NODE_FETCH_EXPORTS = [
  "Headers",
  "Request",
  "Response",
  "FetchError",
  "AbortError",
] as const;

export interface FetchRouteInit {
  readonly agent?: unknown;
  readonly signal?: unknown;
  readonly [name: string]: unknown;
}

export interface NodeFetchV2 {
  (input: unknown, init?: FetchRouteInit): Promise<unknown>;
  readonly default: NodeFetchV2;
  readonly __esModule: true;
  readonly Headers: (...args: never[]) => unknown;
  readonly Request: (...args: never[]) => unknown;
  readonly Response: (...args: never[]) => unknown;
  readonly FetchError: (...args: never[]) => unknown;
  readonly AbortError: (...args: never[]) => unknown;
  readonly [name: string]: unknown;
}

export function requireAcceptanceOrigin(value: string | undefined): string {
  if (value === undefined) throw new TypeError("Telegram acceptance origin is missing");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Telegram acceptance origin is invalid");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.port === "" ||
    Number(parsed.port) === 0 ||
    parsed.origin !== value
  ) {
    throw new TypeError("Telegram acceptance origin is invalid");
  }
  return parsed.origin;
}

export function requireNodeFetchV2(value: unknown): NodeFetchV2 {
  const candidate = value as Record<string, unknown>;
  if (
    typeof value !== "function" ||
    candidate.default !== value ||
    candidate.__esModule !== true ||
    REQUIRED_NODE_FETCH_EXPORTS.some((name) => typeof candidate[name] !== "function")
  ) {
    throw new TypeError("Telegram fetch export shape is invalid");
  }
  return value as NodeFetchV2;
}

function requestedUrl(input: unknown): string | undefined {
  if (typeof input === "string" || input instanceof URL) return input.toString();
  if (
    input !== null &&
    typeof input === "object" &&
    "url" in input &&
    typeof input.url === "string"
  ) {
    return input.url;
  }
  return undefined;
}

export function createTelegramRoutedFetch(
  uncheckedFetch: unknown,
  uncheckedOrigin: string,
): NodeFetchV2 {
  const originalFetch = requireNodeFetchV2(uncheckedFetch);
  const origin = requireAcceptanceOrigin(uncheckedOrigin);
  const routedFetch = (input: unknown, init?: FetchRouteInit): Promise<unknown> => {
    const candidate = requestedUrl(input);
    if (candidate === undefined) return originalFetch(input, init);
    let requested: URL;
    try {
      requested = new URL(candidate);
    } catch {
      return originalFetch(input, init);
    }
    if (requested.origin !== TELEGRAM_BOT_API_ORIGIN) {
      return originalFetch(input, init);
    }
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError("Telegram fetch route does not accept Request inputs");
    }
    const routed = new URL(`${requested.pathname}${requested.search}`, origin);
    return originalFetch(routed.toString(), { ...init, agent: undefined });
  };

  for (const key of Reflect.ownKeys(originalFetch)) {
    if (["name", "length", "prototype", "arguments", "caller", "default"].includes(String(key))) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(originalFetch, key);
    if (descriptor !== undefined) Object.defineProperty(routedFetch, key, descriptor);
  }
  const defaultDescriptor = Object.getOwnPropertyDescriptor(originalFetch, "default");
  if (defaultDescriptor === undefined || "value" in defaultDescriptor === false) {
    throw new TypeError("Telegram fetch export shape is invalid");
  }
  Object.defineProperty(routedFetch, "default", {
    ...defaultDescriptor,
    value: routedFetch,
  });
  return requireNodeFetchV2(routedFetch);
}

export function installTelegramFetchRoute(origin: string): void {
  const acceptanceRequire = createRequire(import.meta.url);
  const coreEntry = acceptanceRequire.resolve("@enduragent/core");
  const coreRequire = createRequire(coreEntry);
  const grammyEntry = coreRequire.resolve("grammy");
  const grammyRequire = createRequire(grammyEntry);
  const fetchPath = grammyRequire.resolve("node-fetch");
  const originalFetch = requireNodeFetchV2(grammyRequire(fetchPath));
  const cached = grammyRequire.cache[fetchPath];
  if (cached === undefined || cached.exports !== originalFetch) {
    throw new TypeError("Telegram fetch cache identity is invalid");
  }
  cached.exports = createTelegramRoutedFetch(originalFetch, origin);
}
