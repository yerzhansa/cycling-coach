import { describe, expect, it } from "vitest";
import type {
  NewPlanReconciliationItem,
  NewPlanReconciliationJob,
  PlanRecord,
  PlanReconciliationErrorCode,
  PlanReconciliationItemRecord,
  PlanReconciliationJobRecord,
  PlanReconciliationKind,
  PlanReconciliationRepository,
  PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import {
  cleanupPlanMirror,
  planMirrorExternalId,
  projectPlanReconciliation,
  reconcileActivePlanWindow,
  type PlanMirrorCalendarPort,
  type PlanMirrorCreateInput,
  type PlanMirrorEvent,
} from "../src/index.js";

const PLAN_ID = "01K00000000000000000000001";
const OTHER_PLAN_ID = "01K00000000000000000000002";

function plan(): PlanRecord {
  return {
    id: PLAN_ID,
    originId: null,
    name: "Synthetic Plan",
    primaryGoal: "Synthetic goal",
    startDateKey: 20260824,
    targetDateKey: 20261115,
    status: "active",
    kind: "full_plan",
    totalWeeks: 12,
    weekStartDay: 1,
    structureJson: "{}",
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId: "device",
    hlcPhysicalMs: 1,
    hlcCounter: 0,
  };
}

function workout(id: string, dateKey: number): PlanWorkoutRecord {
  return {
    id,
    planId: PLAN_ID,
    dateKey,
    sport: "cycling",
    name: "Endurance",
    durationS: 3600,
    structureJson: "{}",
    origin: "coach",
    deviceId: "device",
    hlcPhysicalMs: 1,
    hlcCounter: 0,
  };
}

class MemoryReconciliationRepository implements PlanReconciliationRepository {
  readonly jobs = new Map<string, PlanReconciliationJobRecord>();
  readonly items = new Map<string, PlanReconciliationItemRecord>();

  async createOrGetJob(record: NewPlanReconciliationJob): Promise<PlanReconciliationJobRecord> {
    const existing = [...this.jobs.values()].find((job) =>
      job.planId === record.planId
      && job.kind === record.kind
      && job.windowStartDateKey === record.windowStartDateKey
      && job.windowEndDateKey === record.windowEndDateKey
    );
    if (existing !== undefined) return existing;
    const job: PlanReconciliationJobRecord = {
      ...record,
      status: "pending",
      attemptCount: 0,
      failureCount: 0,
      resumedCount: 0,
      lastResumedAttempt: null,
      lastErrorCode: null,
      updatedAtMs: record.createdAtMs,
      completedAtMs: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async readJob(id: string): Promise<PlanReconciliationJobRecord | undefined> {
    return this.jobs.get(id);
  }

  async readLatestJob(
    planId: string,
    kind: PlanReconciliationKind,
  ): Promise<PlanReconciliationJobRecord | undefined> {
    return [...this.jobs.values()].filter((job) => job.planId === planId && job.kind === kind).at(-1);
  }

  async beginAttempt(id: string, updatedAtMs: number): Promise<PlanReconciliationJobRecord> {
    const current = this.jobs.get(id)!;
    const job: PlanReconciliationJobRecord = {
      ...current,
      status: current.status === "failed" || current.status === "retrying" ? "retrying" : "running",
      attemptCount: current.attemptCount + 1,
      resumedCount: current.resumedCount + (current.status === "running" || current.status === "retrying" ? 1 : 0),
      lastResumedAttempt: current.status === "running" || current.status === "retrying"
        ? current.attemptCount + 1
        : null,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: null,
    };
    this.jobs.set(id, job);
    return job;
  }

  async failJob(
    id: string,
    errorCode: PlanReconciliationErrorCode,
    updatedAtMs: number,
  ): Promise<PlanReconciliationJobRecord> {
    const current = this.jobs.get(id)!;
    const job = {
      ...current,
      status: "failed" as const,
      failureCount: current.failureCount + 1,
      lastErrorCode: errorCode,
      updatedAtMs,
    };
    this.jobs.set(id, job);
    return job;
  }

  async verifyJob(id: string, updatedAtMs: number): Promise<PlanReconciliationJobRecord> {
    const job = {
      ...this.jobs.get(id)!,
      status: "verified" as const,
      lastResumedAttempt: null,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: updatedAtMs,
    };
    this.jobs.set(id, job);
    return job;
  }

  async prepareItem(record: NewPlanReconciliationItem): Promise<PlanReconciliationItemRecord> {
    const existing = [...this.items.values()].find((item) =>
      item.jobId === record.jobId
      && item.operation === record.operation
      && item.externalId === record.externalId
    );
    if (existing !== undefined) {
      if (
        existing.expectedJson !== record.expectedJson
        || existing.dateKey !== record.dateKey
        || existing.planWorkoutId !== record.planWorkoutId
      ) {
        const changed: PlanReconciliationItemRecord = {
          ...existing,
          planWorkoutId: record.planWorkoutId,
          dateKey: record.dateKey,
          expectedJson: record.expectedJson,
          status: "pending",
          providerEventId: null,
          lastErrorCode: null,
          updatedAtMs: record.createdAtMs,
          completedAtMs: null,
        };
        this.items.set(existing.id, changed);
        return changed;
      }
      return existing;
    }
    const item: PlanReconciliationItemRecord = {
      ...record,
      status: "pending",
      providerEventId: null,
      attemptCount: 0,
      lastErrorCode: null,
      updatedAtMs: record.createdAtMs,
      completedAtMs: null,
    };
    this.items.set(item.id, item);
    return item;
  }

  async readItems(jobId: string): Promise<readonly PlanReconciliationItemRecord[]> {
    return [...this.items.values()].filter((item) => item.jobId === jobId);
  }

  async startItem(id: string, updatedAtMs: number): Promise<PlanReconciliationItemRecord> {
    const current = this.items.get(id)!;
    const item = {
      ...current,
      status: "running" as const,
      attemptCount: current.attemptCount + 1,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: null,
    };
    this.items.set(id, item);
    return item;
  }

  async markItemCreated(id: string, updatedAtMs: number): Promise<PlanReconciliationItemRecord> {
    const item = {
      ...this.items.get(id)!,
      status: "created" as const,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: null,
    };
    this.items.set(id, item);
    return item;
  }

  async failItem(
    id: string,
    errorCode: Exclude<PlanReconciliationErrorCode, "calendar-list-failed">,
    updatedAtMs: number,
  ): Promise<PlanReconciliationItemRecord> {
    const item = { ...this.items.get(id)!, status: "failed" as const, lastErrorCode: errorCode, updatedAtMs };
    this.items.set(id, item);
    return item;
  }

  async verifyItem(
    id: string,
    providerEventId: number | null,
    updatedAtMs: number,
  ): Promise<PlanReconciliationItemRecord> {
    const item = {
      ...this.items.get(id)!,
      status: "verified" as const,
      providerEventId,
      lastErrorCode: null,
      updatedAtMs,
      completedAtMs: updatedAtMs,
    };
    this.items.set(id, item);
    return item;
  }
}

class MemoryCalendar implements PlanMirrorCalendarPort {
  readonly events: PlanMirrorEvent[] = [];
  readonly creates: PlanMirrorCreateInput[] = [];
  readonly deletes: number[] = [];
  readonly lists: Array<{ readonly startDateKey: number; readonly endDateKey: number }> = [];
  createFailures = 0;
  listFailure = false;
  nextEventId = 100;
  onList: ((call: number) => void) | undefined;

  async listEvents(input: { startDateKey: number; endDateKey: number }) {
    if (this.listFailure) throw new Error("unavailable");
    this.lists.push(input);
    this.onList?.(this.lists.length);
    return this.events.filter((event) => event.dateKey >= input.startDateKey && event.dateKey <= input.endDateKey);
  }

  async createEvent(input: PlanMirrorCreateInput) {
    this.creates.push(input);
    if (this.createFailures > 0) {
      this.createFailures -= 1;
      throw new Error("unavailable");
    }
    this.events.push({ id: this.nextEventId++, dateKey: input.dateKey, externalId: input.externalId });
  }

  async deleteEvent(input: { eventId: number }) {
    this.deletes.push(input.eventId);
    const index = this.events.findIndex((event) => event.id === input.eventId);
    if (index < 0) throw new Error("missing");
    this.events.splice(index, 1);
  }
}

function harness() {
  const repository = new MemoryReconciliationRepository();
  const calendar = new MemoryCalendar();
  let id = 10;
  let now = 10;
  return {
    repository,
    calendar,
    deps: {
      repository,
      calendar,
      identity: { newId: () => `01K00000000000000000000${String(id++).padStart(3, "0")}` },
      now: () => now++,
    },
  };
}

describe("Plan reconciler", () => {
  it("projects every accepted activation and reconciliation domain state", async () => {
    const value = harness();
    const base = await value.repository.createOrGetJob({
      id: "01K00000000000000000000201",
      planId: PLAN_ID,
      kind: "mirror",
      windowStartDateKey: 20260825,
      windowEndDateKey: 20260831,
      createdAtMs: 1,
    });
    const states: Array<readonly [PlanReconciliationJobRecord, string]> = [
      [base, "activation-local"],
      [{ ...base, status: "running", attemptCount: 1 }, "reconcile-running"],
      [{ ...base, status: "failed", attemptCount: 1, failureCount: 1, lastErrorCode: "calendar-create-failed" }, "reconcile-failed"],
      [{ ...base, status: "retrying", attemptCount: 2, failureCount: 1 }, "reconcile-retrying"],
      [{ ...base, status: "failed", attemptCount: 2, failureCount: 2, lastErrorCode: "calendar-create-failed" }, "reconcile-failed-again"],
      [{ ...base, status: "running", attemptCount: 2, resumedCount: 1, lastResumedAttempt: 2 }, "reconcile-crash-resume"],
      [{ ...base, status: "verified", attemptCount: 1, completedAtMs: 2 }, "reconcile-verified"],
    ];
    for (const [job, expected] of states) {
      expect((await projectPlanReconciliation(value.repository, job)).state).toBe(expected);
    }
  });

  it("mirrors only today plus six dates and prechecks every external id before create", async () => {
    const value = harness();
    const today = workout("01K00000000000000000000101", 20260825);
    const daySix = workout("01K00000000000000000000102", 20260831);
    const outside = workout("01K00000000000000000000103", 20260901);
    value.calendar.events.push({
      id: 42,
      dateKey: today.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, today.id),
    });
    const first = await reconcileActivePlanWindow({
      plan: plan(),
      workouts: [today, daySix, outside],
      todayDateKey: 20260825,
    }, value.deps);
    expect(first).toMatchObject({ state: "reconcile-verified", created: 2, pending: 0, failed: 0, total: 2 });
    expect(value.calendar.creates.map((created) => created.planWorkoutId)).toEqual([daySix.id]);
    await reconcileActivePlanWindow({
      plan: plan(),
      workouts: [today, daySix, outside],
      todayDateKey: 20260825,
    }, value.deps);
    expect(value.calendar.creates).toHaveLength(1);
  });

  it("lists again immediately before create and skips an event that appeared after the batch precheck", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260825);
    value.calendar.onList = (call) => {
      if (call === 2) {
        value.calendar.events.push({
          id: 42,
          dateKey: target.dateKey,
          externalId: planMirrorExternalId(PLAN_ID, target.id),
        });
      }
    };
    const result = await reconcileActivePlanWindow({
      plan: plan(),
      workouts: [target],
      todayDateKey: 20260825,
    }, value.deps);
    expect(result).toMatchObject({ state: "reconcile-verified", created: 1, total: 1 });
    expect(value.calendar.creates).toEqual([]);
    expect(value.calendar.lists.slice(0, 2)).toEqual([
      { startDateKey: 20260825, endDateKey: 20260831 },
      { startDateKey: 20260825, endDateKey: 20260825 },
    ]);
  });

  it("fails verification when a provider event disappears after the initial list", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260825);
    value.calendar.events.push({
      id: 42,
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, target.id),
    });
    value.calendar.onList = (call) => {
      if (call === 2) value.calendar.events.splice(0);
    };
    const result = await reconcileActivePlanWindow({
      plan: plan(),
      workouts: [target],
      todayDateKey: 20260825,
    }, value.deps);
    expect(result).toMatchObject({ state: "reconcile-failed", created: 0, failed: 1, total: 1 });
    expect(value.calendar.creates).toEqual([]);
  });

  it("resumes an interrupted item by prechecking the provider instead of duplicating it", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260825);
    const job = await value.repository.createOrGetJob({
      id: "01K00000000000000000000201",
      planId: PLAN_ID,
      kind: "mirror",
      windowStartDateKey: 20260825,
      windowEndDateKey: 20260831,
      createdAtMs: 1,
    });
    const item = await value.repository.prepareItem({
      id: "01K00000000000000000000202",
      jobId: job.id,
      planWorkoutId: target.id,
      operation: "create",
      dateKey: target.dateKey,
      externalId: planMirrorExternalId(PLAN_ID, target.id),
      expectedJson: JSON.stringify({
        dateKey: target.dateKey,
        name: target.name,
        sport: target.sport,
        durationS: target.durationS,
        structureJson: target.structureJson,
      }),
      createdAtMs: 1,
    });
    await value.repository.beginAttempt(job.id, 2);
    await value.repository.startItem(item.id, 3);
    value.calendar.events.push({ id: 42, dateKey: target.dateKey, externalId: item.externalId });
    const result = await reconcileActivePlanWindow({
      plan: plan(),
      workouts: [target],
      todayDateKey: 20260825,
    }, value.deps);
    expect(result).toMatchObject({ state: "reconcile-verified", created: 1, failed: 0 });
    expect(result.job).toMatchObject({ attemptCount: 2, resumedCount: 1 });
    expect(value.calendar.creates).toHaveLength(0);
  });

  it("keeps first and repeated failures distinct until an idempotent retry verifies", async () => {
    const value = harness();
    const target = workout("01K00000000000000000000101", 20260825);
    value.calendar.createFailures = 2;
    const first = await reconcileActivePlanWindow({ plan: plan(), workouts: [target], todayDateKey: 20260825 }, value.deps);
    const second = await reconcileActivePlanWindow({ plan: plan(), workouts: [target], todayDateKey: 20260825 }, value.deps);
    const third = await reconcileActivePlanWindow({ plan: plan(), workouts: [target], todayDateKey: 20260825 }, value.deps);
    expect(first.state).toBe("reconcile-failed");
    expect(second.state).toBe("reconcile-failed-again");
    expect(third).toMatchObject({ state: "reconcile-verified", created: 1, failed: 0 });
    expect(value.calendar.creates).toHaveLength(3);
  });

  it("cleanup preserves today and other Plans while deleting every duplicate tomorrow onward", async () => {
    const value = harness();
    const ownToday = planMirrorExternalId(PLAN_ID, "01K00000000000000000000101");
    const ownTomorrow = planMirrorExternalId(PLAN_ID, "01K00000000000000000000102");
    const otherTomorrow = planMirrorExternalId(OTHER_PLAN_ID, "01K00000000000000000000103");
    value.calendar.events.push(
      { id: 1, dateKey: 20260825, externalId: ownToday },
      { id: 2, dateKey: 20260826, externalId: ownTomorrow },
      { id: 3, dateKey: 20260826, externalId: ownTomorrow },
      { id: 4, dateKey: 20260826, externalId: otherTomorrow },
      { id: 5, dateKey: 20260826, externalId: null },
    );
    const result = await cleanupPlanMirror({
      planId: PLAN_ID,
      todayDateKey: 20260825,
      endDateKey: 20260831,
    }, value.deps);
    expect(result).toMatchObject({ state: "reconcile-verified", created: 1, total: 1 });
    expect(value.calendar.deletes).toEqual([2, 3]);
    expect(value.calendar.events.map((event) => event.id)).toEqual([1, 4, 5]);
  });

  it("persists a list failure without mutating the active local Plan", async () => {
    const value = harness();
    const active = plan();
    value.calendar.listFailure = true;
    const result = await reconcileActivePlanWindow({
      plan: active,
      workouts: [workout("01K00000000000000000000101", 20260825)],
      todayDateKey: 20260825,
    }, value.deps);
    expect(result).toMatchObject({ state: "reconcile-failed", created: 0, pending: 1, failed: 0 });
    expect(active.status).toBe("active");
    expect(value.calendar.creates).toHaveLength(0);
  });
});
