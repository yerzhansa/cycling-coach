import { connectCoachClient, type CoachClient } from "@enduragent/coach-client";
import { AthleteHomeIdentitySchema, type CoachRpcMethodName } from "@enduragent/coach-contract";
import type { DesktopDaemonConnection } from "./daemon-lifecycle.js";
import { requireDesktopDaemonHome } from "./daemon-home-binding.js";
import type { TelegramDaemonBinding } from "./telegram-control.js";

type ConnectCoachClient = typeof connectCoachClient;

export function createTelegramDaemonBinding(
  connection: Pick<
    DesktopDaemonConnection,
    "url" | "token" | "athleteHome" | "generation" | "supervision"
  >,
  selectedAthleteHome: string,
  connect: ConnectCoachClient = connectCoachClient,
): TelegramDaemonBinding {
  requireDesktopDaemonHome(selectedAthleteHome, connection.athleteHome);
  const athleteHome = AthleteHomeIdentitySchema.parse(selectedAthleteHome);
  const call = async <K extends CoachRpcMethodName>(
    method: K,
    request: Parameters<CoachClient["call"]>[1],
  ): Promise<unknown> => {
    const client = await connect({
      url: connection.url,
      token: connection.token,
      expectedAthleteHome: athleteHome,
    });
    try {
      return await client.call(method, request as never);
    } finally {
      await client.close();
    }
  };

  const binding: TelegramDaemonBinding = {
    generation: connection.generation,
    athleteHome,
    supervision: connection.supervision,
    configureTelegram: (request) => call("configureTelegram", request),
    enableTelegram: (request) => call("enableTelegram", request),
    disableTelegram: (request) => call("disableTelegram", request),
    suspendTelegramPolling: (request) => call("suspendTelegramPolling", request),
    resumeTelegramPolling: (request) => call("resumeTelegramPolling", request),
    drainTelegram: (request) => call("drainTelegram", request),
    replaceTelegram: (request) => call("replaceTelegram", request),
    getTelegramStatus: (request) => call("getTelegramStatus", request),
    reconcileTelegram: (request) => call("reconcileTelegram", request),
    inspectTelegramCredential: (request) => call("inspectTelegramCredential", request),
    deleteTelegramWebhook: (request) => call("deleteTelegramWebhook", request),
    forgetTelegramCredential: (request) => call("forgetTelegramCredential", request),
    resetTelegramAccess: (request) => call("resetTelegramAccess", request),
    beginTelegramPairing: (request) => call("beginTelegramPairing", request),
    cancelTelegramPairing: (request) => call("cancelTelegramPairing", request),
    listTelegramAllowedSenders: (request) => call("listTelegramAllowedSenders", request),
    addTelegramAllowedSender: (request) => call("addTelegramAllowedSender", request),
    removeTelegramAllowedSender: (request) => call("removeTelegramAllowedSender", request),
  };
  return Object.freeze(binding);
}
