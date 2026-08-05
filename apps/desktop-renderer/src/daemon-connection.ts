import { CoachClientProtocolError } from "@enduragent/coach-client";
import { RendererCapabilitySchema } from "@enduragent/coach-contract";

export interface RendererDaemonConnection {
  readonly url: `ws://127.0.0.1:${number}/rpc`;
  readonly rendererCapability: string;
  readonly generation: number;
}

export function validateRendererDaemonConnection(value: unknown): RendererDaemonConnection {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CoachClientProtocolError();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "generation,rendererCapability,url") {
    throw new CoachClientProtocolError();
  }
  if (
    typeof record.url !== "string" ||
    typeof record.rendererCapability !== "string" ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) < 1
  ) {
    throw new CoachClientProtocolError();
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new CoachClientProtocolError();
  }
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    !/^\d+$/u.test(url.port) ||
    Number(url.port) < 1 ||
    Number(url.port) > 65_535 ||
    url.pathname !== "/rpc" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !RendererCapabilitySchema.safeParse(record.rendererCapability).success
  ) {
    throw new CoachClientProtocolError();
  }
  return record as unknown as RendererDaemonConnection;
}
