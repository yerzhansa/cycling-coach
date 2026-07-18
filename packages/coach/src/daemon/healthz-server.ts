import type { IncomingMessage, ServerResponse } from "node:http";
import { HEALTHZ_SERVICE_MARKER } from "@enduragent/kernel-node/lock";

export interface HealthzHandlerInput {
  readonly appVersion: string;
  readonly state?: DaemonHealthState;
}

export interface DaemonHealthState {
  readonly healthy: boolean;
  setHealthy(healthy: boolean): void;
}

export function createDaemonHealthState(): DaemonHealthState {
  let healthy = true;
  return {
    get healthy() {
      return healthy;
    },
    setHealthy(value) {
      healthy = value;
    },
  };
}

export function createHealthzRequestHandler(
  input: HealthzHandlerInput,
): (request: IncomingMessage, response: ServerResponse) => void {
  const body = `${JSON.stringify({
    service: HEALTHZ_SERVICE_MARKER,
    version: input.appVersion,
  })}\n`;
  return (request, response) => {
    if (request.method !== "GET" || request.url !== "/healthz") {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (input.state?.healthy === false) {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(`${JSON.stringify({ status: "unavailable" })}\n`);
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.end(body);
  };
}
