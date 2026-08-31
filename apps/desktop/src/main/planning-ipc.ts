import {
  CoachRpcRemoteError,
  connectCoachClient,
  type CoachClient,
} from "@enduragent/coach-client";
import {
  ExecutePlanTransitionRpcParamsSchema,
  ExecutePlanTransitionRpcResultSchema,
  GetPlanStateRpcParamsSchema,
  GetPlanStateRpcResultSchema,
  PlanGetContextV2RequestSchema,
  PlanGetContextV2ResultSchema,
  PlanListV2RequestSchema,
  PlanListV2ResultSchema,
  PlanProgressEventSchema,
  PlanRaceCourseFileSelectionSchema,
  PlanningV2CommandResultSchema,
  PlanningV2CommandSchema,
  type ExecutePlanTransitionRpcParams,
  type ExecutePlanTransitionRpcResult,
  type GetPlanStateRpcParams,
  type GetPlanStateRpcResult,
  type PlanGetContextV2Request,
  type PlanGetContextV2Result,
  type PlanListV2Request,
  type PlanListV2Result,
  type PlanProgressEvent,
  type PlanningV2Command,
  type PlanningV2CommandResult,
} from "@enduragent/coach-contract";
import { homedir } from "node:os";
import { extname, isAbsolute } from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import {
  DESKTOP_PLAN_COURSE_FILE_CHANNEL,
  DESKTOP_PLAN_PROGRESS_CHANNEL,
  DESKTOP_PLAN_STATE_CHANNEL,
  DESKTOP_PLAN_TRANSITION_CHANNEL,
  DESKTOP_PLAN_V2_COMMAND_CHANNEL,
  DESKTOP_PLAN_V2_CONTEXT_CHANNEL,
  DESKTOP_PLAN_V2_LIST_CHANNEL,
} from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";

const unsupported = {
  status: "unsupported-capability" as const,
  capability: "planning" as const,
};

export interface DesktopPlanningClient {
  getPlanState(request: GetPlanStateRpcParams): Promise<GetPlanStateRpcResult>;
  executePlanTransition(
    request: ExecutePlanTransitionRpcParams,
    onEvent?: (event: PlanProgressEvent) => void,
  ): Promise<ExecutePlanTransitionRpcResult>;
  listPlans(request: PlanListV2Request): Promise<PlanListV2Result>;
  getPlanContext(request: PlanGetContextV2Request): Promise<PlanGetContextV2Result>;
  executePlanningCommand(request: PlanningV2Command): Promise<PlanningV2CommandResult>;
}

export interface DesktopPlanningDialogPort {
  showOpenDialog(
    window: BrowserWindow,
    options: OpenDialogOptions,
  ): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

async function callPlanningV2Command(
  client: CoachClient,
  request: PlanningV2Command,
): Promise<PlanningV2CommandResult> {
  switch (request.name) {
    case "plan_creation.start":
      return client.call("plan_creation.start", request);
    case "plan_creation.answer":
      return client.call("plan_creation.answer", request);
    case "plan_creation.preview":
      return client.call("plan_creation.preview", request);
    case "plan_creation.activate":
      return client.call("plan_creation.activate", request);
    case "plan_creation.discard":
      return client.call("plan_creation.discard", request);
    case "plan_change.preview":
      return client.call("plan_change.preview", request);
    case "plan_change.apply":
      return client.call("plan_change.apply", request);
    case "plan.close":
      return client.call("plan.close", request);
  }
}

export function createConnectionPlanningClient(
  connection: Readonly<{
    url: `ws://127.0.0.1:${number}/rpc`;
    token: string;
    athleteHome: string;
  }>,
  connect: typeof connectCoachClient = connectCoachClient,
): DesktopPlanningClient {
  const call = async <T>(operation: (client: CoachClient) => Promise<T>): Promise<T> => {
    const client = await connect({
      url: connection.url,
      token: connection.token,
      expectedAthleteHome: connection.athleteHome,
    });
    try {
      return await operation(client);
    } finally {
      await client.close();
    }
  };
  return {
    async getPlanState(request) {
      try {
        return await call((client) => client.call("getPlanState", request));
      } catch (error) {
        if (error instanceof CoachRpcRemoteError && error.code === -32601) return unsupported;
        throw error;
      }
    },
    async executePlanTransition(request, onEvent) {
      try {
        return await call((client) => client.call("executePlanTransition", request, { onEvent }));
      } catch (error) {
        if (error instanceof CoachRpcRemoteError && error.code === -32601) return unsupported;
        throw error;
      }
    },
    listPlans: (request) => call((client) => client.call("plan.list", request)),
    getPlanContext: (request) => call((client) => client.call("plan.get_context", request)),
    executePlanningCommand: (request) => call((client) => callPlanningV2Command(client, request)),
  };
}

export function installDesktopPlanningIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly dialog: DesktopPlanningDialogPort;
  readonly getPlanState: (request: GetPlanStateRpcParams) => Promise<GetPlanStateRpcResult>;
  readonly executePlanTransition: (
    request: ExecutePlanTransitionRpcParams,
    onEvent: (event: PlanProgressEvent) => void,
  ) => Promise<ExecutePlanTransitionRpcResult>;
  readonly listPlans: (request: PlanListV2Request) => Promise<PlanListV2Result>;
  readonly getPlanContext: (request: PlanGetContextV2Request) => Promise<PlanGetContextV2Result>;
  readonly executePlanningCommand: (request: PlanningV2Command) => Promise<PlanningV2CommandResult>;
}): () => void {
  input.ipcMain.handle(
    DESKTOP_PLAN_STATE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedConnectionRequest(event, input.currentWindow())) {
        throw new Error("untrusted desktop Planning request");
      }
      const parsed = args.length === 0 ? GetPlanStateRpcParamsSchema.safeParse({}) : undefined;
      if (parsed === undefined || !parsed.success) {
        throw new TypeError("invalid desktop Planning request");
      }
      try {
        return GetPlanStateRpcResultSchema.parse(await input.getPlanState(parsed.data));
      } catch {
        throw new TypeError("desktop Planning unavailable");
      }
    },
  );
  input.ipcMain.handle(
    DESKTOP_PLAN_TRANSITION_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedConnectionRequest(event, input.currentWindow())) {
        throw new Error("untrusted desktop Planning request");
      }
      const parsed =
        args.length === 1 ? ExecutePlanTransitionRpcParamsSchema.safeParse(args[0]) : undefined;
      if (parsed === undefined || !parsed.success) {
        throw new TypeError("invalid desktop Planning request");
      }
      try {
        const result = await input.executePlanTransition(parsed.data, (value) => {
          const progress = PlanProgressEventSchema.parse(value);
          const window = input.currentWindow();
          if (
            window !== undefined &&
            !window.isDestroyed() &&
            window.webContents === event.sender &&
            !event.sender.isDestroyed()
          ) {
            event.sender.send(DESKTOP_PLAN_PROGRESS_CHANNEL, progress);
          }
        });
        return ExecutePlanTransitionRpcResultSchema.parse(result);
      } catch {
        throw new TypeError("desktop Planning unavailable");
      }
    },
  );
  input.ipcMain.handle(
    DESKTOP_PLAN_V2_LIST_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedConnectionRequest(event, input.currentWindow())) {
        throw new Error("untrusted desktop Planning request");
      }
      const parsed = args.length === 1 ? PlanListV2RequestSchema.safeParse(args[0]) : undefined;
      if (parsed === undefined || !parsed.success) {
        throw new TypeError("invalid desktop Planning request");
      }
      try {
        return PlanListV2ResultSchema.parse(await input.listPlans(parsed.data));
      } catch {
        throw new TypeError("desktop Planning unavailable");
      }
    },
  );
  input.ipcMain.handle(
    DESKTOP_PLAN_V2_CONTEXT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedConnectionRequest(event, input.currentWindow())) {
        throw new Error("untrusted desktop Planning request");
      }
      const parsed =
        args.length === 1 ? PlanGetContextV2RequestSchema.safeParse(args[0]) : undefined;
      if (parsed === undefined || !parsed.success) {
        throw new TypeError("invalid desktop Planning request");
      }
      try {
        return PlanGetContextV2ResultSchema.parse(await input.getPlanContext(parsed.data));
      } catch {
        throw new TypeError("desktop Planning unavailable");
      }
    },
  );
  input.ipcMain.handle(
    DESKTOP_PLAN_V2_COMMAND_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedConnectionRequest(event, input.currentWindow())) {
        throw new Error("untrusted desktop Planning request");
      }
      const parsed = args.length === 1 ? PlanningV2CommandSchema.safeParse(args[0]) : undefined;
      if (parsed === undefined || !parsed.success) {
        throw new TypeError("invalid desktop Planning request");
      }
      try {
        return PlanningV2CommandResultSchema.parse(await input.executePlanningCommand(parsed.data));
      } catch {
        throw new TypeError("desktop Planning unavailable");
      }
    },
  );
  input.ipcMain.handle(
    DESKTOP_PLAN_COURSE_FILE_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const window = input.currentWindow();
      if (!isTrustedConnectionRequest(event, window)) {
        throw new Error("untrusted desktop Planning request");
      }
      if (args.length !== 0 || window === undefined) {
        throw new TypeError("invalid desktop Planning request");
      }
      try {
        const result = await input.dialog.showOpenDialog(window, {
          defaultPath: homedir(),
          properties: ["openFile"],
          filters: [{ name: "Race Course", extensions: ["gpx", "fit"] }],
        });
        if (result.canceled) return null;
        const path = result.filePaths[0];
        if (
          result.filePaths.length !== 1 ||
          typeof path !== "string" ||
          path.length > 4_096 ||
          !isAbsolute(path) ||
          ![".gpx", ".fit"].includes(extname(path).toLowerCase())
        ) {
          throw new TypeError("invalid Race Course selection");
        }
        return PlanRaceCourseFileSelectionSchema.parse(path);
      } catch (error) {
        if (error instanceof TypeError) throw error;
        return null;
      }
    },
  );
  return () => {
    input.ipcMain.removeHandler(DESKTOP_PLAN_STATE_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_PLAN_TRANSITION_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_PLAN_V2_LIST_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_PLAN_V2_CONTEXT_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_PLAN_V2_COMMAND_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_PLAN_COURSE_FILE_CHANNEL);
  };
}
