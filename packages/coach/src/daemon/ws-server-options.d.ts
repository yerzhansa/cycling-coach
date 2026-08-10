import { IncomingMessage } from "node:http";
import WebSocket from "ws";

declare module "ws" {
  namespace WebSocket {
    interface ServerOptions<
      U extends typeof WebSocket.WebSocket = typeof WebSocket.WebSocket,
      V extends typeof IncomingMessage = typeof IncomingMessage,
    > {
      maxFragments?: number | undefined;
      maxBufferedChunks?: number | undefined;
    }
  }
}
