import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createDaemonHealthState,
  createHealthzRequestHandler,
} from "../src/daemon/healthz-server.js";

function responseCapture() {
  const headers = new Map<string, string>();
  let body = "";
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return response;
    },
    end(value?: string) {
      body += value ?? "";
      return response;
    },
  } as unknown as ServerResponse;
  return { response, headers, body: () => body };
}

describe("healthz request handler", () => {
  it("returns the exact healthy body and headers only for GET /healthz", () => {
    const handler = createHealthzRequestHandler({
      appVersion: "0.1.0-synthetic",
    });
    const capture = responseCapture();
    handler({ method: "GET", url: "/healthz" } as IncomingMessage, capture.response);

    expect(capture.response.statusCode).toBe(200);
    expect(Object.fromEntries(capture.headers)).toEqual({
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    });
    expect(capture.body()).toBe(
      `${JSON.stringify({
        service: "enduragent-store-writer",
        version: "0.1.0-synthetic",
      })}\n`,
    );
  });

  it("omits the healthy marker and version while draining", () => {
    const state = createDaemonHealthState();
    const handler = createHealthzRequestHandler({ appVersion: "synthetic", state });
    state.setHealthy(false);
    const capture = responseCapture();
    handler({ method: "GET", url: "/healthz" } as IncomingMessage, capture.response);
    expect(capture.response.statusCode).toBe(503);
    expect(capture.body()).toBe(`${JSON.stringify({ status: "unavailable" })}\n`);
    expect(capture.body()).not.toContain("enduragent-store-writer");
    expect(capture.body()).not.toContain("synthetic");
  });

  it.each([
    ["POST", "/healthz"],
    ["GET", "/healthz/"],
    ["GET", "/rpc"],
  ])("returns an empty 404 for %s %s", (method, url) => {
    const handler = createHealthzRequestHandler({
      appVersion: "synthetic",
    });
    const capture = responseCapture();
    const end = vi.spyOn(capture.response, "end");
    handler({ method, url } as IncomingMessage, capture.response);
    expect(capture.response.statusCode).toBe(404);
    expect(capture.headers.size).toBe(0);
    expect(capture.body()).toBe("");
    expect(end).toHaveBeenCalledWith();
  });
});
