import type { Config } from "../config.js";
import type { Sport } from "../sport.js";
import type { Memory } from "../memory/store.js";
import type { ResolvedCs } from "../reference/cs-resolution.js";
import { CoachAgent } from "./coach-agent.js";

/**
 * The subset of the agent's public surface the in-process channels consume.
 * A verbatim transcription of the corresponding CoachAgent signatures; the
 * conformance test asserts exact type equality, so the two cannot drift
 * silently.
 */
export interface CoachEngineSeam {
  chat(
    chatId: string,
    userMessage: string,
    turn?: { resolvedCs?: ResolvedCs | null },
  ): Promise<string>;
  hasSession(chatId: string): boolean;
  resetSession(chatId: string): Promise<{ memoryFlushed: boolean }>;
}

/**
 * In-process engine handle: the seam plus the one composition-root
 * accessor that cannot cross a wire boundary — the Memory instance the
 * startup hook mutates before any channel is reachable.
 */
export interface LocalCoachEngine extends CoachEngineSeam {
  getMemory(): Memory;
}

/**
 * Pure delegation: the engine holds no state beyond the wrapped agent and
 * every method forwards verbatim, so reverting to direct CoachAgent
 * construction is a mechanical substitution.
 */
export function createCoachEngine(sport: Sport, config: Config): LocalCoachEngine {
  const agent = new CoachAgent(sport, config);
  return {
    chat: (chatId: string, userMessage: string, turn?: { resolvedCs?: ResolvedCs | null }) =>
      agent.chat(chatId, userMessage, turn),
    hasSession: (chatId: string) => agent.hasSession(chatId),
    resetSession: (chatId: string) => agent.resetSession(chatId),
    getMemory: () => agent.getMemory(),
  };
}
