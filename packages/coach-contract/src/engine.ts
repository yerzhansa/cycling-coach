import { z } from "zod";
import type { TurnEvent } from "./turn-event.js";
import { AthleteStateSchema, type AthleteState } from "./athlete-state.js";

export const ChatRequestSchema = z
  .object({
    chatId: z.string(),
    message: z.string(),
    turn: z
      .object({
        /** An opaque per-turn pace-anchor payload passed through to the engine. */
        resolvedCs: z.unknown().optional(),
        /** Source labels of the reference snapshot the anchor was resolved from. */
        referenceProvenance: z.unknown().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = z.object({ text: z.string() }).strict();
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const StopChatRequestSchema = z.object({ chatId: z.string() }).strict();
export type StopChatRequest = z.infer<typeof StopChatRequestSchema>;

export const StopChatResponseSchema = z.object({ stopped: z.boolean() }).strict();
export type StopChatResponse = z.infer<typeof StopChatResponseSchema>;

export const ResetSessionRequestSchema = z.object({ chatId: z.string() }).strict();
export type ResetSessionRequest = z.infer<typeof ResetSessionRequestSchema>;

export const ResetSessionResponseSchema = z.object({ memoryFlushed: z.boolean() }).strict();
export type ResetSessionResponse = z.infer<typeof ResetSessionResponseSchema>;

export const HasSessionRequestSchema = z.object({ chatId: z.string() }).strict();
export type HasSessionRequest = z.infer<typeof HasSessionRequestSchema>;

export const HasSessionResponseSchema = z.object({ hasSession: z.boolean() }).strict();
export type HasSessionResponse = z.infer<typeof HasSessionResponseSchema>;

/**
 * The single seam between the coaching engine and every surface. In-process
 * consumers call the interface directly; the remote projection is JSON-RPC 2.0
 * over a loopback (127.0.0.1) WebSocket with RPC method names equal to these
 * property names (`chat`, `resetSession`, `hasSession`, `getAthleteState`) —
 * the RPC layer adds no naming layer of its own.
 *
 * Every method is Promise-returning even where today's engine method is
 * synchronous, because the same interface must project over RPC.
 * `getAthleteState` takes no request: the state is a per-athlete-home
 * singleton read.
 */
export interface CoachEngine {
  chat(request: ChatRequest, onEvent?: (event: TurnEvent) => void): Promise<ChatResponse>;
  stopChat?(request: StopChatRequest): Promise<StopChatResponse>;
  resetSession(request: ResetSessionRequest): Promise<ResetSessionResponse>;
  hasSession(request: HasSessionRequest): Promise<HasSessionResponse>;
  getAthleteState(): Promise<AthleteState>;
}
