import type { CoachClient } from "@enduragent/coach-client";
import { CoachClientProtocolError, connectCoachClient } from "@enduragent/coach-client";

export interface DesktopCoachClientProvider {
  getClient(): Promise<CoachClient>;
  reconnect(): Promise<CoachClient>;
  close(): Promise<void>;
}

function validateConnection(value: unknown): { readonly url: string; readonly token: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CoachClientProtocolError();
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "token,url") {
    throw new CoachClientProtocolError();
  }
  if (typeof record.url !== "string" || typeof record.token !== "string") {
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
  return record as { readonly url: string; readonly token: string };
}

export function createDesktopCoachClientProvider(): DesktopCoachClientProvider {
  let client: CoachClient | undefined;
  let connection: Promise<CoachClient> | undefined;
  let reconnection: Promise<CoachClient> | undefined;
  let closing: Promise<void> | undefined;

  const connectFresh = (): Promise<CoachClient> => {
    if (client !== undefined) return Promise.resolve(client);
    if (connection !== undefined) return connection;
    const auth = (
      window as unknown as Window & {
        readonly enduragentAuth: {
          getDaemonConnection(): Promise<unknown>;
        };
      }
    ).enduragentAuth;
    const pending = auth
      .getDaemonConnection()
      .then(validateConnection)
      .then((options) => connectCoachClient(options))
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
        .then(connectFresh)
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
        });
      closing = pending;
      return pending;
    },
  };
}
