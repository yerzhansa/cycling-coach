import { mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_ATTACHMENT_LIMITS } from "@enduragent/coach-contract";
import { createChatAttachmentRepository, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createManagedChatAttachmentStore } from "@enduragent/kernel-node/chat-attachments";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createManagedWorkoutReader } from "@enduragent/sport-cycling/workout-import";
import { createManagedChatAttachmentOperations } from "../src/attachment-operations.js";
import {
  WorkoutAttachmentError,
  createWorkoutAttachmentOperations,
} from "../src/workout-attachment-operations.js";

const roots: string[] = [];
const workoutLimits = {
  candidates: CHAT_ATTACHMENT_LIMITS.workoutCandidates,
  segmentsPerWorkout: CHAT_ATTACHMENT_LIMITS.workoutSegments,
  durationSeconds: CHAT_ATTACHMENT_LIMITS.workoutDurationSeconds,
  diagnostics: CHAT_ATTACHMENT_LIMITS.workoutDiagnostics,
  diagnosticChars: CHAT_ATTACHMENT_LIMITS.workoutDiagnosticChars,
  titleChars: CHAT_ATTACHMENT_LIMITS.workoutTitleChars,
  purposeChars: CHAT_ATTACHMENT_LIMITS.workoutPurposeChars,
} as const;

const zwo = `<workout_file>
  <name>Tempo builder</name>
  <description>Sustainable tempo power</description>
  <sportType>bike</sportType>
  <workout>
    <Warmup Duration="300" PowerLow="0.5" PowerHigh="0.7" />
    <IntervalsT Repeat="3" OnDuration="480" OffDuration="120" OnPower="0.9" OffPower="0.5" />
    <Cooldown Duration="300" PowerLow="0.6" PowerHigh="0.4" />
  </workout>
</workout_file>`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(content = zwo) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "chat-workout-"));
  roots.push(root);
  const archiveDir = join(root, "archive");
  await mkdir(archiveDir, { mode: 0o700 });
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  const repository = createChatAttachmentRepository(store);
  const objects = createManagedChatAttachmentStore({
    archiveDir,
    kindByteLimits: {
      document: CHAT_ATTACHMENT_LIMITS.documentBytes,
      activity: CHAT_ATTACHMENT_LIMITS.activityBytes,
      workout: CHAT_ATTACHMENT_LIMITS.workoutBytes,
      image: CHAT_ATTACHMENT_LIMITS.imageBytes,
    },
  });
  let clock = 2_000;
  const now = () => ++clock;
  const operations = createWorkoutAttachmentOperations({
    repository,
    reader: createManagedWorkoutReader({
      objects,
      limits: {
        ...workoutLimits,
        workoutBytes: CHAT_ATTACHMENT_LIMITS.workoutBytes,
        parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
        parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
      },
    }),
    limits: workoutLimits,
    runExclusive: (work) => work(),
    now,
  });
  const attachments = createManagedChatAttachmentOperations({
    repository,
    objects,
    runExclusive: (work) => work(),
    now,
    randomId: (() => {
      let sequence = 0;
      return () => `workout-attachment-${++sequence}`;
    })(),
    onAdmitted: operations.preprocessAdmitted,
  });
  const staged = await objects.stagePrivateBytes({
    displayName: "tempo.zwo",
    bytes: new TextEncoder().encode(content),
  });
  const admitted = await attachments.admit({
    chatId: "chat-workout",
    selectionId: "selection-workout",
    source: "picker",
    candidate: { kind: "native-path", sourcePath: staged.sourcePath },
  });
  expect(admitted.status).toBe("accepted");
  if (admitted.status !== "accepted") throw new Error("fixture admission failed");
  return { store, repository, operations, attachmentId: admitted.attachmentId };
}

describe("planned Workout attachments", () => {
  it("persists a versioned set and restores a validated athlete selection", async () => {
    const value = await harness();
    expect(await value.repository.readAttachment(value.attachmentId)).toMatchObject({
      kind: "workout",
      status: "ready",
      message_id: null,
      state_json: expect.stringContaining('"kind":"parsed-workout-set"'),
    });
    const set = await value.operations.readWorkoutSet(value.attachmentId);
    expect(set).toMatchObject({
      sourceFormat: "zwo",
      selectedWorkoutId: null,
      workouts: [
        {
          title: "Tempo builder",
          durationSeconds: 2_400,
          purpose: "Sustainable tempo power",
        },
      ],
    });
    const workoutId = set.workouts[0]!.workoutId;
    await expect(
      value.operations.selectWorkout({
        conversationId: "chat-workout",
        attachmentId: value.attachmentId,
        workoutId,
      }),
    ).resolves.toMatchObject({ selectedWorkoutId: workoutId });
    await expect(value.operations.readWorkoutSet(value.attachmentId)).resolves.toMatchObject({
      selectedWorkoutId: workoutId,
    });
    await value.store.close();
  });

  it("rejects an unknown selection without changing the durable projection", async () => {
    const value = await harness();
    await expect(
      value.operations.selectWorkout({
        conversationId: "chat-workout",
        attachmentId: value.attachmentId,
        workoutId: "missing",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<WorkoutAttachmentError>>({
        code: "workout_selection_invalid",
      }),
    );
    await expect(value.operations.readWorkoutSet(value.attachmentId)).resolves.toMatchObject({
      selectedWorkoutId: null,
    });
    await value.store.close();
  });

  it("stores malformed input as a recoverable parse failure", async () => {
    const value = await harness("<workout_file><workout><Script /></workout></workout_file>");
    expect(await value.repository.readAttachment(value.attachmentId)).toMatchObject({
      kind: "workout",
      status: "failed",
      state_json: expect.stringContaining("unsupported_construct"),
      message_id: null,
    });
    await value.store.close();
  });

  it("never writes planned Workouts into canonical Training or Plan storage", async () => {
    const value = await harness();
    const set = await value.operations.readWorkoutSet(value.attachmentId);
    await value.operations.selectWorkout({
      conversationId: "chat-workout",
      attachmentId: value.attachmentId,
      workoutId: set.workouts[0]!.workoutId,
    });
    await expect(value.store.get("SELECT COUNT(*) AS count FROM session")).resolves.toMatchObject({
      count: 0,
    });
    await expect(value.store.get("SELECT COUNT(*) AS count FROM plan")).resolves.toMatchObject({
      count: 0,
    });
    await expect(
      value.store.get("SELECT COUNT(*) AS count FROM plan_workout"),
    ).resolves.toMatchObject({ count: 0 });
    await value.store.close();
  });
});
