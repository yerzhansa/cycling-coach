import { connectCoachClient, type CoachClient } from "@enduragent/coach-client";
import {
  GetTranscriptPageRpcParamsSchema,
  GetTranscriptPageRpcResultSchema,
  type GetTranscriptPageRpcParams,
  type GetTranscriptPageRpcResult,
} from "@enduragent/coach-contract";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_TRANSCRIPT_PAGE_CHANNEL } from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";

export interface DesktopTranscriptReader {
  getTranscriptPage(request: GetTranscriptPageRpcParams): Promise<GetTranscriptPageRpcResult>;
}

export function createConnectionTranscriptReader(
  connection: Readonly<{ url: `ws://127.0.0.1:${number}/rpc`; token: string }>,
  connect: typeof connectCoachClient = connectCoachClient,
): DesktopTranscriptReader {
  const call = async <T>(operation: (client: CoachClient) => Promise<T>): Promise<T> => {
    const client = await connect({ url: connection.url, token: connection.token });
    try {
      return await operation(client);
    } finally {
      await client.close();
    }
  };
  return {
    getTranscriptPage(request) {
      return call((client) => client.call("getTranscriptPage", request));
    },
  };
}

export function installDesktopTranscriptIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly readPage: (request: GetTranscriptPageRpcParams) => Promise<GetTranscriptPageRpcResult>;
}): () => void {
  input.ipcMain.handle(
    DESKTOP_TRANSCRIPT_PAGE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedConnectionRequest(event, input.currentWindow())) {
        throw new Error("untrusted desktop transcript request");
      }
      const parsed =
        args.length === 1 ? GetTranscriptPageRpcParamsSchema.safeParse(args[0]) : undefined;
      if (parsed === undefined || !parsed.success) {
        throw new TypeError("invalid desktop transcript request");
      }
      try {
        return GetTranscriptPageRpcResultSchema.parse(await input.readPage(parsed.data));
      } catch {
        throw new TypeError("desktop transcript unavailable");
      }
    },
  );
  return () => {
    input.ipcMain.removeHandler(DESKTOP_TRANSCRIPT_PAGE_CHANNEL);
  };
}
