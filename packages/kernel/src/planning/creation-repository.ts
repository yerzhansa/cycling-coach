import { canonicalJson } from "../archive/canonical.js";
import type { MigratorStore } from "../store/migrator.js";
import type { Row, SqlStore } from "../store/ports.js";
import { z } from "zod";

export type PlanCreationStore = SqlStore & Pick<MigratorStore, "transaction">;
export type PlanCreationErrorCode =
  | "command-conflict"
  | "stale-version"
  | "missing-creation"
  | "no-unfinished-creation"
  | "corrupt-record";

export class PlanCreationStoreError extends Error {
  constructor(readonly code: PlanCreationErrorCode) {
    super(code);
    this.name = "PlanCreationStoreError";
  }
}

export const PlanCreationSeedV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    eventCandidates: z
      .array(
        z
          .object({
            candidateId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
            name: z.string().min(1).max(512),
            date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
            sourceLabel: z.string().min(1).max(128),
          })
          .strict()
          .readonly(),
      )
      .max(10)
      .readonly(),
  })
  .strict()
  .readonly();
export type PlanCreationSeedV1 = z.infer<typeof PlanCreationSeedV1Schema>;

const PlanCreationAnswerRecordSchema = z
  .object({
    id: z.string(),
    sequence: z.number().int().positive(),
    creationVersion: z.number().int().positive(),
    answerKey: z.string(),
    valueJson: z.string(),
    confirmedAtMs: z.number().int().nonnegative(),
  })
  .readonly();
export type PlanCreationAnswerRecord = z.infer<typeof PlanCreationAnswerRecordSchema>;

const PlanCreationDraftRevisionSchema = z
  .object({
    revisionNumber: z.number().int().positive(),
    parentRevisionNumber: z.number().int().positive().nullable(),
    inputVersion: z.number().int().positive(),
    inputSnapshotJson: z.string(),
    inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
    outputSnapshotJson: z.string(),
    builderId: z.string().min(1),
    builderVersion: z.string().min(1),
    activationFingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .readonly();
export type PlanCreationDraftRevision = z.infer<typeof PlanCreationDraftRevisionSchema>;

const PlanCreationSnapshotSchema = z
  .object({
    id: z.string(),
    status: z.enum(["in-progress", "review", "activated", "discarded"]),
    version: z.number().int().positive(),
    seed: PlanCreationSeedV1Schema.nullable(),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    answers: z.array(PlanCreationAnswerRecordSchema).readonly(),
    currentDraft: PlanCreationDraftRevisionSchema.nullable(),
  })
  .readonly();
export type PlanCreationSnapshot = z.infer<typeof PlanCreationSnapshotSchema>;

export interface PlanCreationCommandStamp {
  readonly commandId: string;
  readonly requestDigest: string;
  readonly nowMs: number;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface StartPlanCreationInput {
  readonly command: PlanCreationCommandStamp;
  readonly creationId: string;
  readonly seed: PlanCreationSeedV1;
}

export interface RecordPlanCreationAnswerInput {
  readonly command: PlanCreationCommandStamp;
  readonly creationId: string;
  readonly expectedVersion: number;
  readonly answerId: string;
  readonly answerKey: string;
  readonly valueJson: string;
}

export interface RecordPlanCreationDraftInput {
  readonly command: PlanCreationCommandStamp;
  readonly creationId: string;
  readonly expectedVersion: number;
  readonly draftId: string;
  readonly inputSnapshotJson: string;
  readonly inputFingerprint: string;
  readonly outputSnapshotJson: string;
  readonly builderId: string;
  readonly builderVersion: string;
  readonly activationFingerprint: string;
}

export interface DiscardPlanCreationInput {
  readonly command: PlanCreationCommandStamp;
  readonly creationId: string;
  readonly expectedVersion: number;
}

export interface PlanCreationRepository {
  readUnfinished(): Promise<PlanCreationSnapshot | undefined>;
  start(input: StartPlanCreationInput): Promise<{
    outcome: "created" | "resumed" | "replayed";
    snapshot: PlanCreationSnapshot;
  }>;
  recordAnswer(input: RecordPlanCreationAnswerInput): Promise<{
    outcome: "recorded" | "replayed";
    snapshot: PlanCreationSnapshot;
  }>;
  replayDraft(command: PlanCreationCommandStamp): Promise<PlanCreationSnapshot | undefined>;
  recordDraft(input: RecordPlanCreationDraftInput): Promise<{
    outcome: "recorded" | "replayed";
    snapshot: PlanCreationSnapshot;
  }>;
  discard(input: DiscardPlanCreationInput): Promise<{
    outcome: "discarded";
  }>;
}

const fail = (): never => {
  throw new PlanCreationStoreError("corrupt-record");
};
const text = (row: Row, key: string): string => {
  const value = row[key];
  return typeof value === "string" ? value : fail();
};
const integer = (row: Row, key: string): number => {
  const value = row[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fail();
};
const json = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return fail();
  }
};
const parseSeed = (value: unknown): PlanCreationSeedV1 => {
  const parsed = PlanCreationSeedV1Schema.safeParse(value);
  return parsed.success ? parsed.data : fail();
};

export function createPlanCreationRepository(store: PlanCreationStore): PlanCreationRepository {
  const readUnfinished = async (): Promise<PlanCreationSnapshot | undefined> => {
    const rows = await store.all(
      "SELECT * FROM plan_creation WHERE status IN ('in-progress','review') ORDER BY created_at_ms,id",
    );
    if (rows.length > 1) fail();
    const row = rows[0];
    if (row === undefined) return undefined;
    const id = text(row, "id");
    const status = text(row, "status");
    if (status !== "in-progress" && status !== "review") fail();
    const seedJson = row.seed_json;
    const seed =
      seedJson === null ? null : typeof seedJson === "string" ? parseSeed(json(seedJson)) : fail();
    const answers = await store.all(
      "SELECT * FROM plan_creation_answer WHERE creation_id=? ORDER BY sequence,id",
      [id],
    );
    const revisionNumber = row.current_draft_revision_number;
    let currentDraft: PlanCreationDraftRevision | null = null;
    if (revisionNumber !== null) {
      const draft = await store.get(
        "SELECT * FROM plan_creation_draft_revision WHERE creation_id=? AND revision_number=?",
        [id, integer(row, "current_draft_revision_number")],
      );
      if (draft === undefined) return fail();
      const parsed = PlanCreationDraftRevisionSchema.safeParse({
        revisionNumber: draft.revision_number,
        parentRevisionNumber: draft.parent_revision_number,
        inputVersion: draft.input_version,
        inputSnapshotJson: draft.input_snapshot_json,
        inputFingerprint: draft.input_fingerprint,
        outputSnapshotJson: draft.output_snapshot_json,
        builderId: draft.builder_id,
        builderVersion: draft.builder_version,
        activationFingerprint: draft.activation_fingerprint,
      });
      if (!parsed.success) return fail();
      currentDraft = parsed.data;
      json(currentDraft.inputSnapshotJson);
      json(currentDraft.outputSnapshotJson);
    }
    return {
      id,
      status: status === "review" ? "review" : "in-progress",
      version: integer(row, "version"),
      seed,
      currentDraft,
      createdAtMs: integer(row, "created_at_ms"),
      updatedAtMs: integer(row, "updated_at_ms"),
      answers: answers.map((answer) => {
        const valueJson = text(answer, "value_json");
        json(valueJson);
        return {
          id: text(answer, "id"),
          sequence: integer(answer, "sequence"),
          creationVersion: integer(answer, "creation_version"),
          answerKey: text(answer, "answer_key"),
          valueJson,
          confirmedAtMs: integer(answer, "confirmed_at_ms"),
        };
      }),
    };
  };
  const requireUnfinished = async () => {
    const snapshot = await readUnfinished();
    if (snapshot === undefined) throw new PlanCreationStoreError("missing-creation");
    return snapshot;
  };
  const hasReplay = async (
    name:
      | "plan_creation.start"
      | "plan_creation.answer"
      | "plan_creation.discard"
      | "plan_creation.preview",
    command: PlanCreationCommandStamp,
  ) => {
    const row = await store.get(
      "SELECT request_digest,status,result_json FROM planning_command WHERE command_name=? AND command_id=?",
      [name, command.commandId],
    );
    if (row === undefined) return undefined;
    if (text(row, "request_digest") !== command.requestDigest)
      throw new PlanCreationStoreError("command-conflict");
    if (text(row, "status") !== "succeeded") fail();
    return row;
  };
  const replay = async (
    name: "plan_creation.start" | "plan_creation.answer",
    command: PlanCreationCommandStamp,
  ) => ((await hasReplay(name, command)) ? requireUnfinished() : undefined);
  const replayDraft = async (command: PlanCreationCommandStamp) => {
    const row = await hasReplay("plan_creation.preview", command);
    if (row === undefined) return undefined;
    const parsed = PlanCreationSnapshotSchema.safeParse(json(text(row, "result_json")));
    return parsed.success ? parsed.data : fail();
  };
  const recordCommand = (
    name:
      | "plan_creation.start"
      | "plan_creation.answer"
      | "plan_creation.discard"
      | "plan_creation.preview",
    command: PlanCreationCommandStamp,
    creationId: string,
    result: unknown,
  ) =>
    store.run(
      `INSERT INTO planning_command (
command_name,command_id,request_digest,status,aggregate_refs_json,result_json,error_code,error_json,
version,created_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?, ?, ?, 'succeeded', ?, ?, NULL, NULL, 2, ?, ?, ?, ?, ?)`,
      [
        name,
        command.commandId,
        command.requestDigest,
        canonicalJson({ creationId }),
        canonicalJson(result),
        command.nowMs,
        command.nowMs,
        command.deviceId,
        command.hlcPhysicalMs,
        command.hlcCounter,
      ],
    );
  return {
    readUnfinished,
    replayDraft,
    async start({ command, creationId, seed }) {
      return store.transaction(async () => {
        const prior = await replay("plan_creation.start", command);
        if (prior) return { outcome: "replayed", snapshot: prior };
        let snapshot = await readUnfinished();
        const outcome = snapshot ? "resumed" : "created";
        if (!snapshot) {
          await store.run(
            `INSERT INTO plan_creation (
id,status,version,seed_json,current_draft_revision_number,activated_plan_id,created_at_ms,updated_at_ms,
terminal_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?, 'in-progress', 1, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?)`,
            [
              creationId,
              canonicalJson(seed),
              command.nowMs,
              command.nowMs,
              command.deviceId,
              command.hlcPhysicalMs,
              command.hlcCounter,
            ],
          );
          snapshot = await requireUnfinished();
        }
        await recordCommand("plan_creation.start", command, snapshot.id, {
          creationId: snapshot.id,
          outcome,
        });
        return { outcome, snapshot };
      });
    },
    async recordAnswer({ command, creationId, expectedVersion, answerId, answerKey, valueJson }) {
      return store.transaction(async () => {
        const prior = await replay("plan_creation.answer", command);
        if (prior) return { outcome: "replayed", snapshot: prior };
        const current = await requireUnfinished();
        if (current.id !== creationId) throw new PlanCreationStoreError("missing-creation");
        if (current.version !== expectedVersion) throw new PlanCreationStoreError("stale-version");
        const version = expectedVersion + 1;
        await store.run(
          `INSERT INTO plan_creation_answer (
id,creation_id,sequence,creation_version,answer_key,value_json,scope,preference_id,confirmed_at_ms,
device_id,hlc_physical_ms,hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, 'plan-creation', NULL, ?, ?, ?, ?)`,
          [
            answerId,
            creationId,
            current.answers.length + 1,
            version,
            answerKey,
            valueJson,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
          ],
        );
        await store.run(
          `UPDATE plan_creation SET version=?,updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status IN ('in-progress','review') AND version=?`,
          [
            version,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
            creationId,
            expectedVersion,
          ],
        );
        const snapshot = await requireUnfinished();
        if (snapshot.id !== creationId || snapshot.version !== version)
          throw new PlanCreationStoreError("stale-version");
        await recordCommand("plan_creation.answer", command, creationId, {
          creationId,
          answerId,
          version,
        });
        return { outcome: "recorded", snapshot };
      });
    },
    async recordDraft(input) {
      const { command, creationId, expectedVersion } = input;
      return store.transaction(async () => {
        const prior = await replayDraft(command);
        if (prior) return { outcome: "replayed", snapshot: prior };
        const current = await readUnfinished();
        if (current === undefined || current.id !== creationId)
          throw new PlanCreationStoreError("no-unfinished-creation");
        if (current.version !== expectedVersion) throw new PlanCreationStoreError("stale-version");
        const parentRevisionNumber = current.currentDraft?.revisionNumber ?? null;
        const revisionNumber = (parentRevisionNumber ?? 0) + 1;
        await store.run(
          `INSERT INTO plan_creation_draft_revision (
id,creation_id,revision_number,parent_revision_number,input_version,input_snapshot_json,
input_fingerprint,builder_id,builder_version,output_snapshot_json,activation_fingerprint,
created_at_ms,device_id,hlc_physical_ms,hlc_counter
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.draftId,
            creationId,
            revisionNumber,
            parentRevisionNumber,
            expectedVersion,
            input.inputSnapshotJson,
            input.inputFingerprint,
            input.builderId,
            input.builderVersion,
            input.outputSnapshotJson,
            input.activationFingerprint,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
          ],
        );
        await store.run(
          `UPDATE plan_creation SET status='review',current_draft_revision_number=?,version=version+1,
updated_at_ms=?,device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status IN ('in-progress','review') AND version=?`,
          [
            revisionNumber,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
            creationId,
            expectedVersion,
          ],
        );
        const snapshot = await requireUnfinished();
        if (
          snapshot.id !== creationId ||
          snapshot.version !== expectedVersion + 1 ||
          snapshot.currentDraft?.revisionNumber !== revisionNumber ||
          snapshot.status !== "review"
        )
          throw new PlanCreationStoreError("stale-version");
        await recordCommand("plan_creation.preview", command, creationId, snapshot);
        return { outcome: "recorded", snapshot };
      });
    },
    async discard({ command, creationId, expectedVersion }) {
      return store.transaction(async () => {
        if (await hasReplay("plan_creation.discard", command)) return { outcome: "discarded" };
        const current = await readUnfinished();
        if (current === undefined || current.id !== creationId)
          throw new PlanCreationStoreError("no-unfinished-creation");
        if (current.version !== expectedVersion) throw new PlanCreationStoreError("stale-version");
        const version = expectedVersion + 1;
        const updated = await store.get(
          `UPDATE plan_creation SET status='discarded',terminal_at_ms=?,updated_at_ms=?,version=version+1,
device_id=?,hlc_physical_ms=?,hlc_counter=?
WHERE id=? AND status IN ('in-progress','review') AND version=?
RETURNING status,version`,
          [
            command.nowMs,
            command.nowMs,
            command.deviceId,
            command.hlcPhysicalMs,
            command.hlcCounter,
            creationId,
            expectedVersion,
          ],
        );
        if (updated === undefined) throw new PlanCreationStoreError("stale-version");
        if (text(updated, "status") !== "discarded" || integer(updated, "version") !== version) {
          fail();
        }
        await recordCommand("plan_creation.discard", command, creationId, {
          creationId,
          outcome: "discarded",
          version,
        });
        return { outcome: "discarded" };
      });
    },
  };
}
