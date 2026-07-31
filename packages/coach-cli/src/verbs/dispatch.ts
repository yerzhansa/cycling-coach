import type { CoachCliVerb } from "../args.js";
import { ImportFilesRpcParamsSchema } from "@enduragent/coach-contract";
import { resolve } from "node:path";
import type { CoachVerbRequest } from "./types.js";

interface CreateCoachVerbRequestInput {
  readonly verb: CoachCliVerb;
  readonly chatId: string | undefined;
  readonly stdinText: string | undefined;
  readonly signal: AbortSignal;
  readonly callerCwd: string;
}

const ignoreNotification = () => {};
const ignoreTerminal: CoachVerbRequest["onTerminalEnvelope"] = () => {};

function chatMessage(
  verb: Exclude<CoachCliVerb, { readonly name: "state" | "import" | "sync" }>,
  stdinText?: string,
): string {
  switch (verb.name) {
    case "ask":
      if (verb.input.kind === "argv") return verb.input.text;
      if (stdinText === undefined) throw new TypeError("missing stdin text");
      return stdinText;
    case "analyze":
      return `/analyze ${JSON.stringify(verb.target)}`;
    case "plan-week":
      return "/plan";
    case "wellness-set":
      return `/wellness set ${JSON.stringify(verb.entries)}`;
  }
}

export function createCoachVerbRequest(input: CreateCoachVerbRequestInput): CoachVerbRequest {
  if (input.verb.name === "state") {
    return {
      method: "getAthleteState",
      params: {},
      signal: input.signal,
      onNotificationEnvelope: ignoreNotification,
      onTerminalEnvelope: ignoreTerminal,
    };
  }
  if (input.verb.name === "import") {
    return {
      method: "importFiles",
      params: ImportFilesRpcParamsSchema.parse({
        paths: input.verb.paths.map((path) => resolve(input.callerCwd, path)),
      }),
      signal: input.signal,
      onNotificationEnvelope: ignoreNotification,
      onTerminalEnvelope: ignoreTerminal,
    };
  }
  if (input.verb.name === "sync") {
    return {
      method: "sync",
      params: {},
      signal: input.signal,
      onNotificationEnvelope: ignoreNotification,
      onTerminalEnvelope: ignoreTerminal,
    };
  }
  if (input.chatId === undefined) throw new TypeError("missing chat session");
  return {
    method: "chat",
    params: {
      chatId: input.chatId,
      message: chatMessage(input.verb, input.stdinText),
    },
    signal: input.signal,
    onNotificationEnvelope: ignoreNotification,
    onTerminalEnvelope: ignoreTerminal,
  };
}
