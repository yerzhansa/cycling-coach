import { z } from "zod";
import type { SqlReadStore } from "../store/ports.js";

const FenceSchema = z.object({
  activePlanId: z.string().nullable(),
  creationId: z.string().nullable(),
  chatAuthoritySinceMs: z.number().nullable(),
});

export type LegacyWriterFenceState = z.infer<typeof FenceSchema>;

export function createLegacyWriterFence(store: Pick<SqlReadStore, "get">) {
  const read = async (): Promise<LegacyWriterFenceState> =>
    FenceSchema.parse(
      (await store.get(`SELECT
        (SELECT plan_id FROM planning_plan WHERE status='active') AS activePlanId,
        (SELECT id FROM plan_creation WHERE status IN ('in-progress','review')) AS creationId,
        (SELECT chat_authority_since_ms FROM planning_authority WHERE singleton = 1) AS chatAuthoritySinceMs`)) ?? {
        activePlanId: null,
        creationId: null,
        chatAuthoritySinceMs: null,
      },
    );
  return {
    read,
    async fenced(): Promise<boolean> {
      const state = await read();
      return (
        state.activePlanId !== null ||
        state.creationId !== null ||
        state.chatAuthoritySinceMs !== null
      );
    },
  };
}
