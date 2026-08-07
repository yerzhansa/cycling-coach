import { describe, expect, it, vi } from "vitest";
import {
  createTelegramRoutedFetch,
  requireAcceptanceOrigin,
  requireNodeFetchV2,
  type FetchRouteInit,
  type NodeFetchV2,
} from "./fixtures/packaged-telegram/telegram-fetch-route.js";

function constructor(): never {
  throw new Error("not called");
}

function nodeFetchV2(call: (input: unknown, init?: FetchRouteInit) => Promise<unknown>) {
  const fetch = vi.fn(call) as unknown as NodeFetchV2;
  Object.defineProperties(fetch, {
    __esModule: { value: true },
    default: { configurable: true, enumerable: true, writable: true, value: fetch },
    Headers: { enumerable: true, value: constructor },
    Request: { enumerable: true, value: constructor },
    Response: { enumerable: true, value: constructor },
    FetchError: { enumerable: true, value: constructor },
    AbortError: { enumerable: true, value: constructor },
  });
  return fetch;
}

describe("packaged Telegram fetch route", () => {
  it("rewrites only the exact Bot API origin and preserves request configuration", async () => {
    const result = { ok: true };
    const original = nodeFetchV2(async () => result);
    const routed = createTelegramRoutedFetch(original, "http://127.0.0.1:43117");
    const signal = new AbortController().signal;

    await expect(
      routed("https://api.telegram.org/bot123/getUpdates?offset=4", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"offset":4}',
        signal,
        agent: { protocol: "https:" },
      }),
    ).resolves.toBe(result);

    expect(original).toHaveBeenCalledWith(
      "http://127.0.0.1:43117/bot123/getUpdates?offset=4",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"offset":4}',
        signal,
        agent: undefined,
      }),
    );
    expect(routed.default).toBe(routed);
    for (const name of ["Headers", "Request", "Response", "FetchError", "AbortError"] as const) {
      expect(routed[name]).toBe(original[name]);
    }
  });

  it("delegates every non-Bot API input unchanged", async () => {
    const original = nodeFetchV2(async () => ({ ok: true }));
    const routed = createTelegramRoutedFetch(original, "http://127.0.0.1:43117");
    const input = "https://example.test/bot123/getUpdates";
    const init = { method: "GET", agent: { protocol: "https:" } };

    await routed(input, init);

    expect(original).toHaveBeenCalledWith(input, init);
  });

  it("rejects Bot API Request objects instead of dropping their request semantics", async () => {
    const original = nodeFetchV2(async () => ({ ok: true }));
    const routed = createTelegramRoutedFetch(original, "http://127.0.0.1:43117");
    const input = {
      url: "https://api.telegram.org/bot123/getUpdates",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"offset":4}',
    };

    expect(() => routed(input)).toThrow("Telegram fetch route does not accept Request inputs");
    expect(original).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "https://127.0.0.1:43117",
    "http://localhost:43117",
    "http://user@127.0.0.1:43117",
    "http://127.0.0.1:43117/path",
    "http://127.0.0.1:43117?query=1",
    "http://127.0.0.1:43117/#fragment",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
  ])("rejects invalid acceptance origin %s", (origin) => {
    expect(() => requireAcceptanceOrigin(origin)).toThrow("Telegram acceptance origin is invalid");
  });

  it("distinguishes a missing origin from malformed origins", () => {
    expect(() => requireAcceptanceOrigin(undefined)).toThrow(
      "Telegram acceptance origin is missing",
    );
  });

  it.each([
    undefined,
    {},
    Object.assign(() => Promise.resolve(), { __esModule: true }),
    Object.assign(() => Promise.resolve(), { __esModule: true, default: () => Promise.resolve() }),
  ])("fails closed on an unexpected node-fetch v2 export shape", (candidate) => {
    expect(() => requireNodeFetchV2(candidate)).toThrow("Telegram fetch export shape is invalid");
  });
});
