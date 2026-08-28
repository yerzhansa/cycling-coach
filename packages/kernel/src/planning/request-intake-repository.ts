import type { MigratorStore } from "../store/migrator.js";
import type { SqlStore } from "../store/ports.js";
import {
  validatePlanConversationRecord,
  validatePlanSourceRequestRecord,
  type PlanConversationRecord,
  type PlanSourceRequestRecord,
} from "./conversation-repository.js";
import {
  validatePlanProposalPremiseRecord,
  validatePlanProposalRecord,
  type PlanProposalPremiseRecord,
  type PlanProposalRecord,
} from "./proposal-repository.js";
import type { PlanningRequestAttention } from "./request-repository.js";

export type PlanningRequestIntakeDestination =
  | {
      readonly kind: "conversation";
      readonly conversation: PlanConversationRecord;
      readonly createConversation: boolean;
      readonly sourceRequest: PlanSourceRequestRecord;
    }
  | {
      readonly kind: "proposal";
      readonly proposal: PlanProposalRecord;
      readonly premises: readonly PlanProposalPremiseRecord[];
      readonly attention: Extract<PlanningRequestAttention, "needs_review" | "date_conflict">;
      readonly resolvedDateKey: number | null;
    };

export interface AcceptPlanningRequestIntakeInput {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly destination: PlanningRequestIntakeDestination;
  readonly updatedAtMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export class PlanningRequestIntakeStoreError extends Error {
  readonly code: "invalid-intake" | "missing-request" | "stale-request" | "intake-conflict";

  constructor(code: PlanningRequestIntakeStoreError["code"]) {
    super(`planning request intake rejected: ${code}`);
    this.name = "PlanningRequestIntakeStoreError";
    this.code = code;
  }
}

export interface PlanningRequestIntakeRepository {
  accept(input: AcceptPlanningRequestIntakeInput): Promise<void>;
}

type IntakeStore = SqlStore & Pick<MigratorStore, "transaction">;

const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function validClock(input: AcceptPlanningRequestIntakeInput): boolean {
  return (
    input.requestId.length > 0 &&
    Number.isSafeInteger(input.expectedRevision) &&
    input.expectedRevision > 0 &&
    Number.isSafeInteger(input.updatedAtMs) &&
    input.updatedAtMs >= 0 &&
    DEVICE_ID.test(input.deviceId) &&
    Number.isSafeInteger(input.hlcPhysicalMs) &&
    input.hlcPhysicalMs >= 0 &&
    Number.isSafeInteger(input.hlcCounter) &&
    input.hlcCounter >= 0
  );
}

export function createPlanningRequestIntakeRepository(
  store: IntakeStore,
): PlanningRequestIntakeRepository {
  return Object.freeze({
    async accept(input: AcceptPlanningRequestIntakeInput) {
      if (!validClock(input)) throw new PlanningRequestIntakeStoreError("invalid-intake");
      if (input.destination.kind === "conversation") {
        validatePlanConversationRecord(input.destination.conversation);
        validatePlanSourceRequestRecord(input.destination.sourceRequest);
        if (
          input.destination.conversation.status !== "open" ||
          input.destination.sourceRequest.conversationId !== input.destination.conversation.id
        ) {
          throw new PlanningRequestIntakeStoreError("invalid-intake");
        }
      } else {
        validatePlanProposalRecord(input.destination.proposal);
        if (
          input.destination.proposal.status !== "proposed" ||
          input.destination.premises.length === 0
        ) {
          throw new PlanningRequestIntakeStoreError("invalid-intake");
        }
        for (const premise of input.destination.premises) {
          validatePlanProposalPremiseRecord(premise);
          if (premise.proposalId !== input.destination.proposal.id) {
            throw new PlanningRequestIntakeStoreError("invalid-intake");
          }
        }
      }

      await store.transaction(async () => {
        const current = await store.get(
          `SELECT lifecycle,revision,updated_at_ms,plan_conversation_id,proposal_id
FROM planning_request WHERE request_id=?`,
          [input.requestId],
        );
        if (current === undefined) throw new PlanningRequestIntakeStoreError("missing-request");
        if (
          current.lifecycle !== "open" ||
          current.revision !== input.expectedRevision ||
          typeof current.updated_at_ms !== "number" ||
          current.updated_at_ms > input.updatedAtMs
        ) {
          throw new PlanningRequestIntakeStoreError("stale-request");
        }
        if (current.plan_conversation_id !== null || current.proposal_id !== null) {
          throw new PlanningRequestIntakeStoreError("intake-conflict");
        }

        if (input.destination.kind === "conversation") {
          const { conversation, sourceRequest } = input.destination;
          const existing = await store.get(
            "SELECT plan_id,replaces_plan_id,status FROM plan_conversation WHERE id=?",
            [conversation.id],
          );
          if (input.destination.createConversation) {
            if (existing !== undefined) {
              throw new PlanningRequestIntakeStoreError("intake-conflict");
            }
            await store.run(
              `INSERT INTO plan_conversation (
  id,plan_id,replaces_plan_id,course_choice_status,race_course_json,status,ended_at_ms,
  created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
              [
                conversation.id,
                conversation.planId,
                conversation.replacesPlanId,
                conversation.courseChoiceStatus,
                conversation.raceCourseJson,
                conversation.status,
                conversation.endedAtMs,
                conversation.createdAtMs,
                conversation.updatedAtMs,
                conversation.deviceId,
                conversation.hlcPhysicalMs,
                conversation.hlcCounter,
              ],
            );
          } else if (
            existing === undefined ||
            existing.plan_id !== conversation.planId ||
            existing.replaces_plan_id !== conversation.replacesPlanId ||
            existing.status !== "open"
          ) {
            throw new PlanningRequestIntakeStoreError("intake-conflict");
          }
          await store.run(
            `INSERT INTO plan_source_request (
  id,conversation_id,source_chat_id,source_boundary_ref,source_message_id,request_json,
  created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              sourceRequest.id,
              sourceRequest.conversationId,
              sourceRequest.sourceChatId,
              sourceRequest.sourceBoundaryRef,
              sourceRequest.sourceMessageId,
              sourceRequest.requestJson,
              sourceRequest.createdAtMs,
              sourceRequest.updatedAtMs,
              sourceRequest.deviceId,
              sourceRequest.hlcPhysicalMs,
              sourceRequest.hlcCounter,
            ],
          );
          await store.run(
            `UPDATE planning_request SET
  plan_conversation_id=?,revision=revision+1,updated_at_ms=?,device_id=?,
  hlc_physical_ms=?,hlc_counter=?
WHERE request_id=? AND lifecycle='open' AND revision=?`,
            [
              conversation.id,
              input.updatedAtMs,
              input.deviceId,
              input.hlcPhysicalMs,
              input.hlcCounter,
              input.requestId,
              input.expectedRevision,
            ],
          );
          return;
        }

        const { proposal, premises } = input.destination;
        await store.run(
          `INSERT INTO plan_proposal (
  id,plan_id,parent_proposal_id,revision,status,title,rationale,confidence,mutation_json,
  base_snapshot_json,refusal_reason,created_at_ms,updated_at_ms,resolved_at_ms,device_id,
  hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            proposal.id,
            proposal.planId,
            proposal.parentProposalId,
            proposal.revision,
            proposal.status,
            proposal.title,
            proposal.rationale,
            proposal.confidence,
            proposal.mutationJson,
            proposal.baseSnapshotJson,
            proposal.refusalReason,
            proposal.createdAtMs,
            proposal.updatedAtMs,
            proposal.resolvedAtMs,
            proposal.deviceId,
            proposal.hlcPhysicalMs,
            proposal.hlcCounter,
          ],
        );
        for (const premise of premises) {
          await store.run(
            `INSERT INTO plan_proposal_premise (
  id,proposal_id,source_type,source_id,source_label,source_date_key,confidence,
  snapshot_json,created_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              premise.id,
              premise.proposalId,
              premise.sourceType,
              premise.sourceId,
              premise.sourceLabel,
              premise.sourceDateKey,
              premise.confidence,
              premise.snapshotJson,
              premise.createdAtMs,
              premise.deviceId,
              premise.hlcPhysicalMs,
              premise.hlcCounter,
            ],
          );
        }
        await store.run(
          `UPDATE planning_request SET
  proposal_id=?,attention=?,resolved_date_key=?,revision=revision+1,updated_at_ms=?,device_id=?,
  hlc_physical_ms=?,hlc_counter=?
WHERE request_id=? AND lifecycle='open' AND revision=?`,
          [
            proposal.id,
            input.destination.attention,
            input.destination.resolvedDateKey,
            input.updatedAtMs,
            input.deviceId,
            input.hlcPhysicalMs,
            input.hlcCounter,
            input.requestId,
            input.expectedRevision,
          ],
        );
      });
    },
  });
}
