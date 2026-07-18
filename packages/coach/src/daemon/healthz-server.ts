import type { IncomingMessage, ServerResponse } from "node:http";
import { PROTOCOL_VERSION, type DaemonOwner } from "@enduragent/coach-contract";
import { HEALTHZ_SERVICE_MARKER } from "@enduragent/kernel-node/lock";

export interface HealthzHandlerInput {
  readonly appVersion: string;
  readonly owner: DaemonOwner;
}

export function createHealthzRequestHandler(
  input: HealthzHandlerInput,
): (request: IncomingMessage, response: ServerResponse) => void {
  const body = `${JSON.stringify({
    service: HEALTHZ_SERVICE_MARKER,
    version: input.appVersion,
    protocolVersion: PROTOCOL_VERSION,
    owner: input.owner,
  })}\n`;
  return (request, response) => {
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(body);
  };
}
