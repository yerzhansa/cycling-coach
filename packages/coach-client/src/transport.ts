import { CoachClientTransportUnavailableError } from "./errors.js";

export type CoachWebSocketFactory = (url: string) => WebSocket;

export function resolveCoachWebSocketFactory(
  override?: CoachWebSocketFactory,
): CoachWebSocketFactory {
  if (override !== undefined) return override;
  const WebSocketImplementation = globalThis.WebSocket;
  if (typeof WebSocketImplementation !== "function") {
    throw new CoachClientTransportUnavailableError();
  }
  return (url: string) => new WebSocketImplementation(url);
}
