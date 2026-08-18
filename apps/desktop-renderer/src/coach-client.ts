import type { CoachClient } from "@enduragent/coach-client";
import {
  CoachClientDisconnectedError,
  connectCoachClient,
  type CoachClientTerminalCause,
} from "@enduragent/coach-client";
import { validateRendererDaemonConnection } from "./daemon-connection.js";

export interface DesktopCoachClientProvider {
  getClient(): Promise<CoachClient>;
  reconnect(): Promise<CoachClient>;
  close(): Promise<void>;
}

interface DesktopConnectionBridge {
  getDaemonConnection(failedGeneration?: number): Promise<unknown>;
}

export function createDesktopCoachClientProvider(
  connect: typeof connectCoachClient = connectCoachClient,
): DesktopCoachClientProvider {
  let client: CoachClient | undefined;
  let connection: Promise<CoachClient> | undefined;
  let reconnection: Promise<CoachClient> | undefined;
  let closing: Promise<void> | undefined;
  let shutdownCause: CoachClientDisconnectedError | undefined;
  let generation: number | undefined;
  let failedGeneration: number | undefined;

  const auth = (): DesktopConnectionBridge =>
    (
      window as unknown as Window & {
        readonly enduragentAuth: DesktopConnectionBridge;
      }
    ).enduragentAuth;

  const connectFresh = (recoveryGeneration = failedGeneration): Promise<CoachClient> => {
    if (shutdownCause !== undefined) return Promise.reject(shutdownCause);
    if (client !== undefined) return Promise.resolve(client);
    if (connection !== undefined) return connection;
    let connectingClient: CoachClient | undefined;
    let terminalDuringConnect:
      | { readonly client: CoachClient; readonly cause: CoachClientTerminalCause }
      | undefined;
    let connectionGeneration: number | undefined;
    const onTerminal = (failedClient: CoachClient, cause: CoachClientTerminalCause): void => {
      if (connectingClient === undefined) {
        terminalDuringConnect = { client: failedClient, cause };
        return;
      }
      if (failedClient !== connectingClient || client !== failedClient) return;
      client = undefined;
      if (connection === pending) connection = undefined;
      failedGeneration = connectionGeneration;
    };
    const pending = auth()
      .getDaemonConnection(recoveryGeneration)
      .then(validateRendererDaemonConnection)
      .then((options) => {
        if (shutdownCause !== undefined) throw shutdownCause;
        connectionGeneration = options.generation;
        generation = options.generation;
        return connect({ url: options.url, token: options.rendererCapability, onTerminal });
      })
      .then(async (connected) => {
        connectingClient = connected;
        if (terminalDuringConnect?.client === connected) {
          if (connection === pending) {
            connection = undefined;
            failedGeneration = connectionGeneration;
          }
          throw terminalDuringConnect.cause;
        }
        if (shutdownCause !== undefined) {
          await connected.close();
          throw shutdownCause;
        }
        if (connection === pending) {
          client = connected;
          generation = connectionGeneration;
          failedGeneration = undefined;
        }
        return connected;
      })
      .catch((error: unknown) => {
        if (connection === pending) {
          if (shutdownCause === undefined) {
            failedGeneration = connectionGeneration;
          }
          connection = undefined;
        }
        throw error;
      });
    connection = pending;
    return pending;
  };

  return {
    getClient() {
      if (shutdownCause !== undefined) return Promise.reject(shutdownCause);
      return reconnection ?? connectFresh(failedGeneration);
    },
    reconnect() {
      if (shutdownCause !== undefined) return Promise.reject(shutdownCause);
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
        .then(() => connectFresh(failedGeneration ?? generation))
        .finally(() => {
          if (reconnection === pending) reconnection = undefined;
        });
      reconnection = pending;
      return pending;
    },
    close() {
      if (closing !== undefined) return closing;
      shutdownCause = new CoachClientDisconnectedError(1000, "");
      const closingClient = client;
      const closingConnection = connection;
      const closingReconnection = reconnection;
      let targetClient: CoachClient | undefined;
      let targetConnection: Promise<CoachClient> | undefined;
      let targetReconnection: Promise<CoachClient> | undefined;
      const pending = Promise.resolve(closingReconnection ?? closingConnection)
        .catch(() => undefined)
        .then((connected) => connected ?? closingClient)
        .then(async (connected) => {
          targetClient = client === connected ? client : undefined;
          targetConnection = targetClient === undefined ? undefined : connection;
          targetReconnection = targetClient === undefined ? undefined : reconnection;
          await connected?.close();
        })
        .finally(() => {
          if (client === closingClient || client === targetClient) client = undefined;
          if (connection === closingConnection || connection === targetConnection) {
            connection = undefined;
          }
          if (reconnection === closingReconnection || reconnection === targetReconnection) {
            reconnection = undefined;
          }
          generation = undefined;
          failedGeneration = undefined;
        });
      closing = pending;
      return pending;
    },
  };
}
