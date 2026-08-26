import { connectCoachClient, type CoachClient } from "@enduragent/coach-client";
import {
  GetPlanningReadModelRpcResultSchema,
  type GetPlanningReadModelRpcResult,
} from "@enduragent/coach-contract";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_PLANNING_READ_CHANNEL } from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";

export interface DesktopPlanningReader {
  getPlanningReadModel(): Promise<GetPlanningReadModelRpcResult>;
}

export function createConnectionPlanningReader(
  connection: Readonly<{
    url: `ws://127.0.0.1:${number}/rpc`;
    token: string;
    athleteHome: string;
  }>,
  connect: typeof connectCoachClient = connectCoachClient,
): DesktopPlanningReader {
  return {
    async getPlanningReadModel() {
      const client: CoachClient = await connect({
        url: connection.url,
        token: connection.token,
        expectedAthleteHome: connection.athleteHome,
      });
      try {
        return await client.call("getPlanningReadModel", {});
      } finally {
        await client.close();
      }
    },
  };
}

export function installDesktopPlanningReadIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly read: () => Promise<GetPlanningReadModelRpcResult>;
}): () => void {
  input.ipcMain.handle(
    DESKTOP_PLANNING_READ_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedConnectionRequest(event, input.currentWindow())) {
        throw new Error("untrusted desktop Planning request");
      }
      if (args.length !== 0) throw new TypeError("invalid desktop Planning request");
      try {
        return GetPlanningReadModelRpcResultSchema.parse(await input.read());
      } catch {
        throw new TypeError("desktop Planning unavailable");
      }
    },
  );
  return () => input.ipcMain.removeHandler(DESKTOP_PLANNING_READ_CHANNEL);
}
