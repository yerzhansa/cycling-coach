import type { CoachClient } from "@enduragent/coach-client";
import { CoachClientProtocolError, connectCoachClient } from "@enduragent/coach-client";

export interface DesktopCoachClientProvider {
  getClient(): Promise<CoachClient>;
  reconnect(): Promise<CoachClient>;
  close(): Promise<void>;
}

interface DesktopConnectionBridge {
  getDaemonConnection(failedGeneration?: number): Promise<unknown>;
}

function validateConnection(value: unknown): {
  readonly url: string;
  readonly token: string;
  readonly generation: number;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CoachClientProtocolError();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "generation,token,url") {
    throw new CoachClientProtocolError();
  }
  if (
    typeof record.url !== "string" ||
    typeof record.token !== "string" ||
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
    !/^[A-Za-z0-9_-]{43}$/u.test(record.token)
  ) {
    throw new CoachClientProtocolError();
  }
  return record as { readonly url: string; readonly token: string; readonly generation: number };
}

export function createDesktopCoachClientProvider(
  connect: typeof connectCoachClient = connectCoachClient,
): DesktopCoachClientProvider {
  let client: CoachClient | undefined;
  let connection: Promise<CoachClient> | undefined;
  let reconnection: Promise<CoachClient> | undefined;
  let closing: Promise<void> | undefined;
  let generation: number | undefined;

  const auth = (): DesktopConnectionBridge =>
    (
      window as unknown as Window & {
        readonly enduragentAuth: DesktopConnectionBridge;
      }
    ).enduragentAuth;

  const connectFresh = (failedGeneration?: number): Promise<CoachClient> => {
    if (client !== undefined) return Promise.resolve(client);
    if (connection !== undefined) return connection;
    const pending = auth()
      .getDaemonConnection(failedGeneration)
      .then(validateConnection)
      .then((options) => {
        generation = options.generation;
        return connect({ url: options.url, token: options.token });
      })
      .then((connected) => {
        if (connection === pending) client = connected;
        return connected;
      })
      .catch((error: unknown) => {
        if (connection === pending) connection = undefined;
        throw error;
      });
    connection = pending;
    return pending;
  };

  return {
    getClient() {
      return reconnection ?? connectFresh();
    },
    reconnect() {
      if (reconnection !== undefined) return reconnection;
      const previous = client;
      const previousConnection = connection;
      client = undefined;
      const pending = Promise.resolve(previousConnection)
        .catch(() => undefined)
        .then((connected) => connected ?? previous)
        .then(async (connected) => {
          await connected?.close();
          if (client === connected) client = undefined;
          if (connection === previousConnection) connection = undefined;
        })
        .then(() => connectFresh(generation))
        .finally(() => {
          if (reconnection === pending) reconnection = undefined;
        });
      reconnection = pending;
      return pending;
    },
    close() {
      if (closing !== undefined) return closing;
      const pending = Promise.resolve(reconnection ?? connection)
        .catch(() => undefined)
        .then((connected) => connected ?? client)
        .then((connected) => connected?.close())
        .then(() => {
          client = undefined;
          connection = undefined;
          generation = undefined;
        });
      closing = pending;
      return pending;
    },
  };
}
