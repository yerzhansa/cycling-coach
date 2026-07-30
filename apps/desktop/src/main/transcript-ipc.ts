import { connectCoachClient, type CoachClient } from "@enduragent/coach-client";
import {
  GetArchivedTranscriptPageRpcParamsSchema,
  GetArchivedTranscriptPageRpcResultSchema,
  GetTranscriptPageRpcParamsSchema,
  GetTranscriptPageRpcResultSchema,
  ListArchivedConversationsRpcParamsSchema,
  ListArchivedConversationsRpcResultSchema,
  type GetArchivedTranscriptPageRpcParams,
  type GetArchivedTranscriptPageRpcResult,
  type GetTranscriptPageRpcParams,
  type GetTranscriptPageRpcResult,
  type ListArchivedConversationsRpcParams,
  type ListArchivedConversationsRpcResult,
} from "@enduragent/coach-contract";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { ZodType } from "zod";
import {
  DESKTOP_ARCHIVED_CONVERSATIONS_CHANNEL,
  DESKTOP_ARCHIVED_TRANSCRIPT_PAGE_CHANNEL,
  DESKTOP_TRANSCRIPT_PAGE_CHANNEL,
} from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";

export interface DesktopTranscriptReader {
  getTranscriptPage(request: GetTranscriptPageRpcParams): Promise<GetTranscriptPageRpcResult>;
  listArchivedConversations(
    request: ListArchivedConversationsRpcParams,
  ): Promise<ListArchivedConversationsRpcResult>;
  getArchivedTranscriptPage(
    request: GetArchivedTranscriptPageRpcParams,
  ): Promise<GetArchivedTranscriptPageRpcResult>;
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
    listArchivedConversations(request) {
      return call((client) => client.call("listArchivedConversations", request));
    },
    getArchivedTranscriptPage(request) {
      return call((client) => client.call("getArchivedTranscriptPage", request));
    },
  };
}

function readHandler<Request, Result>(
  currentWindow: () => BrowserWindow | undefined,
  requestSchema: ZodType<Request>,
  resultSchema: ZodType<Result>,
  read: (request: Request) => Promise<Result>,
  expectedArguments: 0 | 1,
): (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<Result> {
  return async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    if (!isTrustedConnectionRequest(event, currentWindow())) {
      throw new Error("untrusted desktop transcript request");
    }
    const parsed =
      args.length === expectedArguments
        ? requestSchema.safeParse(expectedArguments === 0 ? {} : args[0])
        : undefined;
    if (parsed === undefined || !parsed.success) {
      throw new TypeError("invalid desktop transcript request");
    }
    try {
      return resultSchema.parse(await read(parsed.data));
    } catch {
      throw new TypeError("desktop transcript unavailable");
    }
  };
}

export function installDesktopTranscriptIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly readPage: (request: GetTranscriptPageRpcParams) => Promise<GetTranscriptPageRpcResult>;
  readonly readArchivedConversations: (
    request: ListArchivedConversationsRpcParams,
  ) => Promise<ListArchivedConversationsRpcResult>;
  readonly readArchivedPage: (
    request: GetArchivedTranscriptPageRpcParams,
  ) => Promise<GetArchivedTranscriptPageRpcResult>;
}): () => void {
  const channels = [
    DESKTOP_TRANSCRIPT_PAGE_CHANNEL,
    DESKTOP_ARCHIVED_CONVERSATIONS_CHANNEL,
    DESKTOP_ARCHIVED_TRANSCRIPT_PAGE_CHANNEL,
  ] as const;
  input.ipcMain.handle(
    DESKTOP_TRANSCRIPT_PAGE_CHANNEL,
    readHandler(
      input.currentWindow,
      GetTranscriptPageRpcParamsSchema,
      GetTranscriptPageRpcResultSchema,
      input.readPage,
      1,
    ),
  );
  input.ipcMain.handle(
    DESKTOP_ARCHIVED_CONVERSATIONS_CHANNEL,
    readHandler(
      input.currentWindow,
      ListArchivedConversationsRpcParamsSchema,
      ListArchivedConversationsRpcResultSchema,
      input.readArchivedConversations,
      0,
    ),
  );
  input.ipcMain.handle(
    DESKTOP_ARCHIVED_TRANSCRIPT_PAGE_CHANNEL,
    readHandler(
      input.currentWindow,
      GetArchivedTranscriptPageRpcParamsSchema,
      GetArchivedTranscriptPageRpcResultSchema,
      input.readArchivedPage,
      1,
    ),
  );
  return () => {
    for (const channel of channels) input.ipcMain.removeHandler(channel);
  };
}
