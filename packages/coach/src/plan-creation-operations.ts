import {
  PlanCreationAnswerRpcParamsSchema,
  PlanCreationAnswerRpcResultSchema,
  PlanCreationStartRpcParamsSchema,
  PlanCreationStartRpcResultSchema,
  type PlanCreationCardModel,
  type PlanCreationOperations,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  PlanCreationStoreError,
  type PlanCreationRepository,
  type PlanCreationSnapshot,
} from "@enduragent/kernel/planning";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import {
  encodePlanCreationAnswer,
  projectPlanCreationCard,
  resolvePlanCreationAnswerFlow,
  validPlanCreationAnswer,
  type PlanCreationAnswerKey,
  type PlanCreationBaselineEvidence,
} from "./plan-creation-answers.js";

export { projectPlanCreationCard } from "./plan-creation-answers.js";

export interface GoalEventCandidateSource {
  read(): Promise<readonly { name: string; date: string; sourceLabel: string }[]>;
}

export interface BaselineEvidenceSource {
  read(): Promise<PlanCreationBaselineEvidence | undefined>;
}

export function expectedPlanCreationAnswerKind(
  snapshot: PlanCreationSnapshot,
): PlanCreationAnswerKey | null {
  return resolvePlanCreationAnswerFlow(snapshot).next;
}

export interface PlanCreationHost extends PlanCreationOperations {
  readCard(): Promise<PlanCreationCardModel | null>;
}

async function requestDigest(crypto: Crypto, request: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(request)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const defaultBaselineEvidence: BaselineEvidenceSource = { read: async () => undefined };

export function createPlanCreationOperations(input: {
  repository: PlanCreationRepository;
  identity: AuthoredIdentity;
  crypto: Crypto;
  eventCandidates: GoalEventCandidateSource;
  baselineEvidence?: BaselineEvidenceSource;
  today?: () => string;
}): PlanCreationHost {
  const baselineEvidence = input.baselineEvidence ?? defaultBaselineEvidence;
  const today = input.today ?? (() => new Date().toISOString().slice(0, 10));
  const stamp = async (commandId: string, digest: string) => {
    const clock = input.identity.hlcStamp();
    return {
      commandId,
      requestDigest: digest,
      nowMs: clock.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: clock.physicalMs,
      hlcCounter: clock.counter,
    };
  };
  const persistDerivedBaseline = async (
    snapshot: PlanCreationSnapshot,
  ): Promise<PlanCreationSnapshot> => {
    if (expectedPlanCreationAnswerKind(snapshot) !== "baseline") return snapshot;
    let evidence: PlanCreationBaselineEvidence | undefined;
    try {
      evidence = await baselineEvidence.read();
    } catch {
      return snapshot;
    }
    const label = evidence?.label.trim().slice(0, 128) ?? "";
    if (evidence === undefined || label.length === 0) return snapshot;
    const answer = { kind: "baseline", baseline: evidence.baseline } as const;
    const source = { kind: "derived", label } as const;
    const request = {
      creationId: snapshot.id,
      expectedVersion: snapshot.version,
      answer,
      source,
    };
    const digest = await requestDigest(input.crypto, request);
    try {
      const result = await input.repository.recordAnswer({
        command: await stamp(`plan-creation-derived-baseline:${digest}`, digest),
        creationId: snapshot.id,
        expectedVersion: snapshot.version,
        answerId: input.identity.newUlid(),
        answerKey: "baseline",
        valueJson: encodePlanCreationAnswer(answer, source),
      });
      return result.snapshot;
    } catch (error) {
      if (
        error instanceof PlanCreationStoreError &&
        ["stale-version", "command-conflict", "missing-creation"].includes(error.code)
      ) {
        return (await input.repository.readUnfinished()) ?? snapshot;
      }
      throw error;
    }
  };
  const project = async (snapshot: PlanCreationSnapshot): Promise<PlanCreationCardModel> => {
    const current = await persistDerivedBaseline(snapshot);
    return projectPlanCreationCard(current, { today: today() });
  };
  const readCard = async (): Promise<PlanCreationCardModel | null> => {
    const snapshot = await input.repository.readUnfinished();
    return snapshot === undefined ? null : project(snapshot);
  };
  return {
    async "plan_creation.start"(request) {
      const parsed = PlanCreationStartRpcParamsSchema.parse(request);
      const current = await input.repository.readUnfinished();
      const candidates =
        current === undefined
          ? (await input.eventCandidates.read()).slice(0, 10).map((candidate) => ({
              candidateId: input.identity.newUlid(),
              ...candidate,
            }))
          : [];
      try {
        const result = await input.repository.start({
          command: await stamp(parsed.commandId, await requestDigest(input.crypto, parsed)),
          creationId: current?.id ?? input.identity.newUlid(),
          seed: { schemaVersion: 1, eventCandidates: candidates },
        });
        return PlanCreationStartRpcResultSchema.parse({
          status: "started",
          outcome: result.outcome === "created" ? "created" : "resumed",
          planCreation: await project(result.snapshot),
        });
      } catch (error) {
        if (error instanceof PlanCreationStoreError && error.code === "command-conflict") {
          return PlanCreationStartRpcResultSchema.parse({
            status: "rejected",
            reason: "command-conflict",
          });
        }
        throw error;
      }
    },
    async "plan_creation.answer"(request) {
      const parsed = PlanCreationAnswerRpcParamsSchema.parse(request);
      const snapshot = await input.repository.readUnfinished();
      if (snapshot === undefined || snapshot.id !== parsed.creationId) {
        return PlanCreationAnswerRpcResultSchema.parse({
          status: "rejected",
          reason: "no-unfinished-creation",
          planCreation: snapshot === undefined ? null : await project(snapshot),
        });
      }
      const digest = await requestDigest(input.crypto, parsed);
      const stampValue = await stamp(parsed.commandId, digest);
      const answerId = input.identity.newUlid();
      const record = () =>
        input.repository.recordAnswer({
          command: stampValue,
          creationId: parsed.creationId,
          expectedVersion: parsed.expectedVersion,
          answerId,
          answerKey: parsed.answer.kind,
          valueJson: encodePlanCreationAnswer(parsed.answer, { kind: "athlete" }),
        });
      if (snapshot.version === parsed.expectedVersion) {
        const flow = resolvePlanCreationAnswerFlow(snapshot);
        if (flow.next !== parsed.answer.kind && !flow.valid.has(parsed.answer.kind)) {
          return PlanCreationAnswerRpcResultSchema.parse({
            status: "rejected",
            reason: "answer-not-expected",
            planCreation: await project(snapshot),
          });
        }
        if (!validPlanCreationAnswer(snapshot, flow, parsed.answer, today())) {
          return PlanCreationAnswerRpcResultSchema.parse({
            status: "rejected",
            reason: "invalid-answer",
            planCreation: await project(snapshot),
          });
        }
      }
      try {
        const result = await record();
        return PlanCreationAnswerRpcResultSchema.parse({
          status: "answered",
          planCreation: await project(result.snapshot),
        });
      } catch (error) {
        if (
          error instanceof PlanCreationStoreError &&
          ["stale-version", "command-conflict", "missing-creation"].includes(error.code)
        ) {
          return PlanCreationAnswerRpcResultSchema.parse({
            status: "rejected",
            reason: error.code === "missing-creation" ? "no-unfinished-creation" : error.code,
            planCreation: await readCard(),
          });
        }
        throw error;
      }
    },
    readCard,
  };
}
