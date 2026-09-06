import { z } from "zod";
import type { SqlReadStore } from "../store/ports.js";

const FenceSchema = z.object({
  activePlanId: z.string().nullable(),
  creationId: z.string().nullable(),
});

export function createLegacyWriterFence(store: Pick<SqlReadStore, "get">) {
  const read = async (): Promise<{ activePlanId: string | null; creationId: string | null }> =>
    FenceSchema.parse(
      (await store.get(`SELECT
        (SELECT plan_id FROM planning_plan WHERE status='active') AS activePlanId,
        (SELECT id FROM plan_creation WHERE status IN ('in-progress','review')) AS creationId`)) ?? {
        activePlanId: null,
        creationId: null,
      },
    );
  return {
    read,
    async fenced(): Promise<boolean> {
      const state = await read();
      return state.activePlanId !== null || state.creationId !== null;
    },
  };
}
