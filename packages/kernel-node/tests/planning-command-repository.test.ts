import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlanCreationRepository,
  createPlanningCommandRepository,
  hashPlanningCommandRequest,
  PlanningCommandStoreError,
  PlanningTransactionScopeError,
  runPlanningTransaction,
  type ClaimPlanningCommandTransactionInput,
  type CompletePlanningCommandInput,
  type PlanningCommandJsonObject,
  type PlanningTransaction,
} from "@enduragent/kernel/planning";
import { runMigrations, type MigratorStore, type SqlStore } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { createNodeCrypto } from "../src/ingest/import-files.js";
import { openSqliteStorage } from "../src/sqlite/index.js";

const COMMAND_ID = "command-1";
const CREATION_ID = "00000000000000000000000001";
const request = {
  name: "plan_creation.answer",
  creationId: "creation-1",
  expectedRevision: 1,
  answer: { availability: ["monday", "wednesday"] },
};

describe("Planning command repository", () => {
  let store: SqlStore & MigratorStore;
  let repository: ReturnType<typeof createPlanningCommandRepository>;

  beforeEach(async () => {
    store = openSqliteStorage(":memory:");
    await runMigrations(store, MIGRATIONS);
    repository = createPlanningCommandRepository(store, createNodeCrypto());
  });

  afterEach(async () => {
    await store.close();
  });

  it("claims once, reports an identical in-flight command as pending, and conflicts on another digest", async () => {
    const created = await repository.claim({
      commandName: "plan_creation.answer",
      commandId: COMMAND_ID,
      request,
      aggregateRefs: { planCreation: { id: "creation-1", version: 1 } },
      createdAtMs: 100,
      deviceId: "device-1",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    });
    const pending = await repository.claim({
      commandName: "plan_creation.answer",
      commandId: COMMAND_ID,
      request: {
        answer: { availability: ["monday", "wednesday"] },
        expectedRevision: 1,
        creationId: "creation-1",
        name: "plan_creation.answer",
      },
      aggregateRefs: { ignoredOnRetry: true },
      createdAtMs: 200,
      deviceId: "device-2",
      hlcPhysicalMs: 200,
      hlcCounter: 0,
    });

    expect(created).toMatchObject({
      outcome: "claimed",
      command: {
        status: "pending",
        version: 1,
        requestDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(pending).toEqual({ outcome: "pending", command: created.command });
    await expect(
      repository.claim({
        commandName: "plan_creation.answer",
        commandId: COMMAND_ID,
        request: { ...request, expectedRevision: 2 },
        aggregateRefs: {},
        createdAtMs: 300,
        deviceId: "device-1",
        hlcPhysicalMs: 300,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanningCommandStoreError("command-conflict"));
    await expect(store.get("SELECT count(*) AS count FROM planning_command")).resolves.toEqual({
      count: 1,
    });
  });

  it("distinguishes an own __proto__ property in the request digest", async () => {
    const emptyRequest = {};
    const prototypeNamedRequest = JSON.parse(
      '{"__proto__":{"changed":true}}',
    ) as PlanningCommandJsonObject;
    const [emptyDigest, prototypeNamedDigest] = await Promise.all([
      hashPlanningCommandRequest(createNodeCrypto(), emptyRequest),
      hashPlanningCommandRequest(createNodeCrypto(), prototypeNamedRequest),
    ]);

    expect(prototypeNamedDigest).not.toBe(emptyDigest);
    await repository.claim({
      commandName: "plan_creation.start",
      commandId: COMMAND_ID,
      request: emptyRequest,
      aggregateRefs: {},
      createdAtMs: 100,
      deviceId: "device-1",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    });
    await expect(
      repository.claim({
        commandName: "plan_creation.start",
        commandId: COMMAND_ID,
        request: prototypeNamedRequest,
        aggregateRefs: {},
        createdAtMs: 200,
        deviceId: "device-1",
        hlcPhysicalMs: 200,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanningCommandStoreError("command-conflict"));
  });

  it("terminalizes success and replays the stored result for the same canonical request", async () => {
    const claim = await repository.claim({
      commandName: "plan_creation.answer",
      commandId: COMMAND_ID,
      request,
      aggregateRefs: { planCreation: { id: "creation-1", version: 1 } },
      createdAtMs: 100,
      deviceId: "device-1",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    });
    const completed = await repository.complete({
      commandName: "plan_creation.answer",
      commandId: COMMAND_ID,
      requestDigest: claim.command.requestDigest,
      expectedVersion: 1,
      completion: {
        status: "succeeded",
        result: { creationId: "creation-1", revision: 2, answerSaved: true },
      },
      updatedAtMs: 200,
      deviceId: "device-1",
      hlcPhysicalMs: 200,
      hlcCounter: 0,
    });
    const replay = await repository.claim({
      commandName: "plan_creation.answer",
      commandId: COMMAND_ID,
      request,
      aggregateRefs: {},
      createdAtMs: 300,
      deviceId: "device-1",
      hlcPhysicalMs: 300,
      hlcCounter: 0,
    });

    expect(completed).toMatchObject({
      status: "succeeded",
      version: 2,
      result: { creationId: "creation-1", revision: 2, answerSaved: true },
    });
    expect(replay).toEqual({ outcome: "replayed", command: completed });
  });

  it("terminalizes and replays a typed failure", async () => {
    const claim = await repository.claim({
      commandName: "plan_change.apply",
      commandId: COMMAND_ID,
      request: { name: "plan_change.apply", planChangeId: "change-1", expectedRevision: 4 },
      aggregateRefs: { plan: { id: "plan-1", version: 4 }, planChange: { id: "change-1" } },
      createdAtMs: 100,
      deviceId: "device-1",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    });
    const input: CompletePlanningCommandInput = {
      commandName: "plan_change.apply",
      commandId: COMMAND_ID,
      requestDigest: claim.command.requestDigest,
      expectedVersion: 1,
      completion: {
        status: "failed",
        error: { code: "stale-revision", details: { expected: 4, current: 5 } },
      },
      updatedAtMs: 200,
      deviceId: "device-1",
      hlcPhysicalMs: 200,
      hlcCounter: 0,
    };
    const failed = await repository.complete(input);

    expect(failed).toMatchObject({
      status: "failed",
      version: 2,
      result: null,
      error: { code: "stale-revision", details: { expected: 4, current: 5 } },
    });
    await expect(repository.complete(input)).resolves.toEqual(failed);
  });

  it("keeps terminal commands immutable through the repository and database", async () => {
    const claim = await repository.claim({
      commandName: "plan.close",
      commandId: COMMAND_ID,
      request: { name: "plan.close", planId: "plan-1", expectedRevision: 8, reason: "stopped" },
      aggregateRefs: { plan: { id: "plan-1", version: 8 } },
      createdAtMs: 100,
      deviceId: "device-1",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    });
    await repository.complete({
      commandName: "plan.close",
      commandId: COMMAND_ID,
      requestDigest: claim.command.requestDigest,
      expectedVersion: 1,
      completion: { status: "succeeded", result: { planId: "plan-1", lifecycle: "closed" } },
      updatedAtMs: 200,
      deviceId: "device-1",
      hlcPhysicalMs: 200,
      hlcCounter: 0,
    });

    await expect(
      repository.complete({
        commandName: "plan.close",
        commandId: COMMAND_ID,
        requestDigest: claim.command.requestDigest,
        expectedVersion: 2,
        completion: { status: "succeeded", result: { planId: "plan-1", lifecycle: "active" } },
        updatedAtMs: 300,
        deviceId: "device-1",
        hlcPhysicalMs: 300,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanningCommandStoreError("immutable-terminal"));
    await expect(
      store.run(
        "UPDATE planning_command SET updated_at_ms=? WHERE command_name=? AND command_id=?",
        [300, "plan.close", COMMAND_ID],
      ),
    ).rejects.toThrow(/immutable/u);
    await expect(
      store.run("DELETE FROM planning_command WHERE command_name=? AND command_id=?", [
        "plan.close",
        COMMAND_ID,
      ]),
    ).rejects.toThrow(/durable|immutable/u);
  });

  it("rolls back a claim and adjacent aggregate work when the transaction fails", async () => {
    const requestDigest = await hashPlanningCommandRequest(createNodeCrypto(), request);
    const input: ClaimPlanningCommandTransactionInput = {
      commandName: "plan_creation.start",
      commandId: COMMAND_ID,
      requestDigest,
      aggregateRefs: { planCreation: { id: CREATION_ID, version: 1 } },
      createdAtMs: 100,
      deviceId: "device-1",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    };
    await expect(
      runPlanningTransaction(store, async (transaction) => {
        await transaction.commands.claim(input);
        await transaction.planCreations.createOrReadUnfinished({
          id: CREATION_ID,
          seedJson: null,
          createdAtMs: 100,
          deviceId: "device-1",
          hlcPhysicalMs: 100,
          hlcCounter: 0,
        });
        throw new Error("synthetic aggregate failure");
      }),
    ).rejects.toThrow("synthetic aggregate failure");
    await expect(repository.read(input.commandName, input.commandId)).resolves.toBeUndefined();
    await expect(createPlanCreationRepository(store).read(CREATION_ID)).resolves.toBeUndefined();
  });

  it("rolls back adjacent aggregate work when terminalization is stale", async () => {
    const requestDigest = await hashPlanningCommandRequest(createNodeCrypto(), request);
    const claimInput: ClaimPlanningCommandTransactionInput = {
      commandName: "plan_creation.answer",
      commandId: COMMAND_ID,
      requestDigest,
      aggregateRefs: { planCreation: { id: "creation-1", version: 1 } },
      createdAtMs: 100,
      deviceId: "device-1",
      hlcPhysicalMs: 100,
      hlcCounter: 0,
    };
    await runPlanningTransaction(store, (transaction) => transaction.commands.claim(claimInput));
    await expect(
      runPlanningTransaction(store, async (transaction) => {
        await transaction.planCreations.createOrReadUnfinished({
          id: CREATION_ID,
          seedJson: null,
          createdAtMs: 200,
          deviceId: "device-1",
          hlcPhysicalMs: 200,
          hlcCounter: 0,
        });
        await transaction.commands.complete({
          commandName: claimInput.commandName,
          commandId: claimInput.commandId,
          requestDigest,
          expectedVersion: 2,
          completion: { status: "succeeded", result: { creationId: "creation-1" } },
          updatedAtMs: 200,
          deviceId: "device-1",
          hlcPhysicalMs: 200,
          hlcCounter: 0,
        });
      }),
    ).rejects.toEqual(new PlanningCommandStoreError("stale-command"));
    await expect(createPlanCreationRepository(store).read(CREATION_ID)).resolves.toBeUndefined();
    await expect(
      repository.read(claimInput.commandName, claimInput.commandId),
    ).resolves.toMatchObject({
      status: "pending",
      version: 1,
    });
  });

  it("expires transaction-scoped repositories after commit", async () => {
    let escaped: PlanningTransaction | undefined;
    await runPlanningTransaction(store, async (transaction) => {
      escaped = transaction;
    });
    expect(escaped).toBeDefined();
    await expect(escaped!.planCreations.read(CREATION_ID)).rejects.toEqual(
      new PlanningTransactionScopeError(),
    );
    await expect(
      escaped!.commands.claim({
        commandName: "plan_creation.start",
        commandId: "escaped-command",
        requestDigest: "0".repeat(64),
        aggregateRefs: {},
        createdAtMs: 100,
        deviceId: "device-1",
        hlcPhysicalMs: 100,
        hlcCounter: 0,
      }),
    ).rejects.toEqual(new PlanningTransactionScopeError());
  });
});
