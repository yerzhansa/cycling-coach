import {
  ExecutePlanTransitionRpcParamsSchema,
  ExecutePlanTransitionRpcResultSchema,
  GetPlanStateRpcParamsSchema,
  GetPlanStateRpcResultSchema,
  PlanDraftProjectionSchema,
  PlanProgressEventSchema,
  type ChatQueueRunResult,
  type ChatQueueSnapshot,
  type CoachEngine,
  type ExecutePlanTransitionRpcParams,
  type ExecutePlanTransitionRpcResult,
  type PlanDraftProjection,
  type PlanError,
  type PlanProgressEvent,
  type PlanReadModel,
  type PlanningOperations,
  type TurnEvent,
} from "@enduragent/coach-contract";
import { buildPlanLifecycleReadModel } from "./planning-lifecycle.js";
import {
  createPlanConversationRepository,
  createPlanRepository,
  type PlanConversationRecord,
  type PlanConversationRepository,
  type PlanConversationTurnRecord,
  type PlanDraftRevisionRecord,
  type PlanRecord,
  type PlanRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import type { CoachStoreWriterContext } from "./runtime.js";

const EMPTY_QUEUE: ChatQueueSnapshot = Object.freeze({
  schemaVersion: 1,
  revision: 0,
  items: [],
});

const UNAVAILABLE: PlanError = Object.freeze({
  code: "unavailable",
  message: "This Plan action is not available yet.",
  retryable: true,
});

const PROVIDER_FAILED: PlanError = Object.freeze({
  code: "provider-failed",
  message: "The coach couldn’t respond. Try again.",
  retryable: true,
});

const PERSISTENCE_FAILED: PlanError = Object.freeze({
  code: "persistence-failed",
  message: "The Plan couldn’t save that change. Try again.",
  retryable: true,
});

export interface PlanDraftBuild {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly snapshot: unknown;
}

export interface PlanDraftBuilder {
  form(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
  }): Promise<PlanDraftBuild>;
  revise(input: {
    readonly conversation: PlanConversationRecord;
    readonly turns: readonly PlanConversationTurnRecord[];
    readonly previous: PlanDraftRevisionRecord;
    readonly instruction: string;
  }): Promise<PlanDraftBuild>;
}

export interface PlanReadinessInput {
  readonly conversation: PlanConversationRecord;
  readonly turns: readonly PlanConversationTurnRecord[];
  readonly draft: PlanDraftRevisionRecord | undefined;
}

export interface CreatePlanningOperationsDependencies {
  readonly conversations?: PlanConversationRepository;
  readonly plans?: PlanRepository;
  readonly draftBuilder?: PlanDraftBuilder;
  readonly isReady?: (input: PlanReadinessInput) => boolean | Promise<boolean>;
}

function createSerializedLane(): <T>(operation: () => Promise<T>) => Promise<T> {
  let tail = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const task = tail.then(operation, operation);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}

function snapshot(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function draftProjection(value: PlanDraftRevisionRecord | undefined): PlanDraftProjection | null {
  if (value === undefined) return null;
  return PlanDraftProjectionSchema.parse({
    id: value.id,
    planId: value.planId,
    revision: value.revision,
    status: value.status,
    snapshot: snapshot(value.snapshotJson),
  });
}

function queueText(queue: ChatQueueSnapshot): string {
  const head = queue.items[0];
  if (head === undefined) return "";
  if (queue.retryRequired !== undefined) {
    return queue.items
      .slice(0, queue.retryRequired.queuedMessageIds.length)
      .map((item) => item.text)
      .join("\n\n");
  }
  if (head.kind === "slash-command") return head.text;
  let size = 1;
  while (queue.items[size]?.kind === "ordinary") size += 1;
  return queue.items
    .slice(0, size)
    .map((item) => item.text)
    .join("\n\n");
}

export function createPlanningOperations(
  input: {
    readonly context: CoachStoreWriterContext;
    readonly engine: CoachEngine;
    readonly identity: AuthoredIdentity;
  },
  dependencies: CreatePlanningOperationsDependencies = {},
): PlanningOperations {
  const conversations =
    dependencies.conversations ?? createPlanConversationRepository(input.context.store);
  const plans = dependencies.plans ?? createPlanRepository(input.context.store);
  const enqueue = createSerializedLane();

  const read = async (): Promise<PlanReadModel> => {
    const conversation = await conversations.readLatestOpenConversation();
    if (conversation === undefined) {
      return buildPlanLifecycleReadModel({
        conversation: null,
        turns: [],
        readyToCreateDraft: false,
        queue: EMPTY_QUEUE,
        decision: null,
        draft: null,
      });
    }
    const chatId = `plan:${conversation.id}`;
    const [turns, draft, queue, decision] = await Promise.all([
      conversations.readTurns(conversation.id),
      conversations.readLatestDraftRevision(conversation.id),
      input.engine.getChatQueue?.({ chatId }).catch(() => EMPTY_QUEUE) ?? EMPTY_QUEUE,
      input.engine
        .getCoachDecision({ chatId })
        .then((result) => result.decision)
        .catch(() => null),
    ]);
    const ready = await (dependencies.isReady?.({ conversation, turns, draft }) ??
      Promise.resolve(false));
    return buildPlanLifecycleReadModel({
      conversation: {
        id: conversation.id,
        planId: conversation.planId,
        replacesPlanId: conversation.replacesPlanId,
        sourceConversationId: null,
      },
      turns,
      readyToCreateDraft: ready,
      queue,
      decision,
      draft: draftProjection(draft),
    });
  };

  const deliver = (
    onEvent: ((event: PlanProgressEvent) => void) | undefined,
    event: PlanProgressEvent,
  ): void => {
    const parsed = PlanProgressEventSchema.parse(event);
    try {
      onEvent?.(parsed);
    } catch {}
  };

  const appendTurn = async (
    conversationId: string,
    athleteText: string,
    coachText: string,
    engineTurnId: string | null,
  ): Promise<void> => {
    if (!/\S/u.test(coachText) || engineTurnId === null) return;
    const existing = await conversations.readTurns(conversationId);
    if (
      existing.some((turn) => {
        const lineage = snapshot(turn.lineageJson) as { readonly engineTurnId?: unknown };
        return lineage.engineTurnId === engineTurnId;
      })
    ) {
      return;
    }
    const stamp = input.identity.hlcStamp();
    await conversations.appendTurn({
      id: input.identity.newUlid(),
      conversationId,
      sequence: existing.length + 1,
      athleteText,
      coachText,
      lineageJson: JSON.stringify({ engineTurnId }),
      completedAtMs: stamp.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  };

  const executeCoachCall = async (
    command: Extract<ExecutePlanTransitionRpcParams, { transitionId: "PL-T05" }>,
    operationId: string,
    onEvent: ((event: PlanProgressEvent) => void) | undefined,
  ): Promise<void> => {
    const conversation = await conversations.readConversation(command.conversationId);
    if (conversation === undefined || conversation.status !== "open") throw UNAVAILABLE;
    const chatId = `plan:${conversation.id}`;
    const forward = (event: TurnEvent): void => {
      deliver(onEvent, {
        commandId: command.commandId,
        transitionId: command.transitionId,
        operationId,
        phase: "running",
        completed: 0,
        total: 1,
        turnEvent: event,
      });
    };
    let pendingText = command.text;
    let queue = await (input.engine.getChatQueue?.({ chatId }) ?? Promise.resolve(EMPTY_QUEUE));
    if (command.decision !== undefined) {
      let turnId: string | null = null;
      const onTurnEvent = (event: TurnEvent): void => {
        if (event.type === "turn-start") turnId = event.turnId;
        forward(event);
      };
      if (command.decision.action === "skip") {
        await input.engine.skipCoachDecision({
          chatId,
          decisionId: command.decision.decisionId,
        });
        return;
      }
      const result =
        command.decision.action === "answer"
          ? await input.engine.answerCoachDecision(
              {
                chatId,
                decisionId: command.decision.decisionId,
                answer: command.decision.answer,
              },
              onTurnEvent,
            )
          : await input.engine.resumeCoachDecision(
              { chatId, decisionId: command.decision.decisionId },
              onTurnEvent,
            );
      const continuation =
        result.decision.status === "answered" ? result.decision.continuation : null;
      if (continuation?.status === "completed") {
        await appendTurn(
          conversation.id,
          pendingText,
          continuation.coachText,
          turnId ?? continuation.turnId,
        );
      }
      return;
    }
    let first = true;
    while (first || queue.items.length > 0) {
      first = false;
      let turnId: string | null = null;
      const onTurnEvent = (event: TurnEvent): void => {
        if (event.type === "turn-start") turnId = event.turnId;
        forward(event);
      };
      let resultText = "";
      if (queue.items.length > 0 && queueText(queue) === pendingText) {
        let result: ChatQueueRunResult;
        if (queue.retryRequired !== undefined) {
          if (input.engine.retryQueuedTurn === undefined) throw UNAVAILABLE;
          result = await input.engine.retryQueuedTurn(
            { chatId, claimId: queue.retryRequired.claimId },
            onTurnEvent,
          );
        } else if (queue.items[0]?.kind === "slash-command" && queue.items[0]?.restored) {
          if (input.engine.runQueuedCommand === undefined) throw UNAVAILABLE;
          result = await input.engine.runQueuedCommand(
            { chatId, queuedMessageId: queue.items[0].queuedMessageId },
            onTurnEvent,
          );
        } else {
          if (input.engine.resumeChatQueue === undefined) throw UNAVAILABLE;
          result = await input.engine.resumeChatQueue({ chatId }, onTurnEvent);
        }
        resultText = result.response?.text ?? "";
        queue = result.snapshot;
      } else {
        const result = await input.engine.chat({ chatId, message: pendingText }, onTurnEvent);
        resultText = result.text;
        queue = await (input.engine.getChatQueue?.({ chatId }) ?? Promise.resolve(EMPTY_QUEUE));
      }
      await appendTurn(conversation.id, pendingText, resultText, turnId);
      if (queue.retryRequired !== undefined || queue.items.length === 0) break;
      const nextText = queueText(queue);
      if (!/\S/u.test(nextText) || (nextText === pendingText && resultText.length === 0)) break;
      pendingText = nextText;
    }
  };

  const saveDraft = async (
    conversation: PlanConversationRecord,
    previous: PlanDraftRevisionRecord | undefined,
    build: PlanDraftBuild,
  ): Promise<void> => {
    const timestamp = input.identity.hlcStamp().physicalMs;
    await plans.replace(build.plan, build.workouts);
    const conversationStamp = input.identity.hlcStamp();
    await conversations.saveConversation({
      ...conversation,
      planId: build.plan.id,
      updatedAtMs: timestamp,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: conversationStamp.physicalMs,
      hlcCounter: conversationStamp.counter,
    });
    const stamp = input.identity.hlcStamp();
    await conversations.saveDraftRevision({
      id: input.identity.newUlid(),
      conversationId: conversation.id,
      planId: build.plan.id,
      revision: (previous?.revision ?? 0) + 1,
      parentRevisionId: previous?.id ?? null,
      status: "ready",
      snapshotJson: JSON.stringify(build.snapshot),
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
  };

  const reject = async (error: PlanError): Promise<ExecutePlanTransitionRpcResult> =>
    ExecutePlanTransitionRpcResultSchema.parse({ status: "rejected", error, state: await read() });

  return {
    async getPlanState(request) {
      GetPlanStateRpcParamsSchema.parse(request);
      return GetPlanStateRpcResultSchema.parse({ status: "ready", state: await read() });
    },
    executePlanTransition(request, onEvent) {
      const command = ExecutePlanTransitionRpcParamsSchema.parse(request);
      return enqueue(async () => {
        if (command.transitionId === "PL-T01") {
          let conversation = await conversations.readLatestOpenConversation();
          if (conversation === undefined) {
            const timestamp = input.identity.hlcStamp().physicalMs;
            const stamp = input.identity.hlcStamp();
            conversation = {
              id: input.identity.newUlid(),
              planId: null,
              replacesPlanId: null,
              status: "open",
              endedAtMs: null,
              createdAtMs: timestamp,
              updatedAtMs: timestamp,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            };
            await conversations.saveConversation(conversation);
          }
          return ExecutePlanTransitionRpcResultSchema.parse({
            status: "completed",
            state: await read(),
          });
        }
        if (command.transitionId === "PL-T05") {
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "queued",
            completed: 0,
            total: 1,
          });
          try {
            await executeCoachCall(command, operationId, onEvent);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch (error) {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(error === UNAVAILABLE ? UNAVAILABLE : PROVIDER_FAILED);
          }
        }
        if (command.transitionId === "PL-T06" || command.transitionId === "PL-T07") {
          if (dependencies.draftBuilder === undefined) return reject(UNAVAILABLE);
          const operationId = input.identity.newUlid();
          deliver(onEvent, {
            commandId: command.commandId,
            transitionId: command.transitionId,
            operationId,
            phase: "running",
            completed: 0,
            total: 1,
          });
          try {
            const selectedDraft =
              command.transitionId === "PL-T07"
                ? await conversations.readDraftRevision(command.draftId)
                : undefined;
            const conversation =
              command.transitionId === "PL-T06"
                ? await conversations.readConversation(command.conversationId)
                : selectedDraft === undefined
                  ? undefined
                  : await conversations.readConversationByPlanId(selectedDraft.planId);
            if (conversation === undefined || conversation.status !== "open")
              return reject(UNAVAILABLE);
            const turns = await conversations.readTurns(conversation.id);
            const previous = await conversations.readLatestDraftRevision(conversation.id);
            const build =
              command.transitionId === "PL-T06"
                ? await dependencies.draftBuilder.form({ conversation, turns })
                : previous === undefined
                  ? null
                  : await dependencies.draftBuilder.revise({
                      conversation,
                      turns,
                      previous,
                      instruction: command.text,
                    });
            if (build === null) return reject(UNAVAILABLE);
            await saveDraft(conversation, previous, build);
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "completed",
              completed: 1,
              total: 1,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            deliver(onEvent, {
              commandId: command.commandId,
              transitionId: command.transitionId,
              operationId,
              phase: "failed",
              completed: 0,
              total: 1,
            });
            return reject(PERSISTENCE_FAILED);
          }
        }
        if (command.transitionId === "PL-T10") {
          try {
            const current = await conversations.readDraftRevision(command.draftId);
            if (current === undefined) return reject(UNAVAILABLE);
            const timestamp = input.identity.hlcStamp().physicalMs;
            const stamp = input.identity.hlcStamp();
            await conversations.saveDraftRevision({
              ...current,
              status: "discarded",
              updatedAtMs: timestamp,
              deviceId: await input.identity.deviceId(),
              hlcPhysicalMs: stamp.physicalMs,
              hlcCounter: stamp.counter,
            });
            return ExecutePlanTransitionRpcResultSchema.parse({
              status: "completed",
              state: await read(),
            });
          } catch {
            return reject(PERSISTENCE_FAILED);
          }
        }
        return reject(UNAVAILABLE);
      });
    },
  };
}
