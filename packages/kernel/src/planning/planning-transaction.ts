import type { MigratorStore } from "../store/migrator.js";
import type { SqlStore } from "../store/ports.js";
import {
  createAthletePlanningContextRepositoryInTransaction,
  type AthletePlanningContextRepository,
} from "./athlete-planning-context-repository.js";
import {
  createPlanAggregateRepositoryInTransaction,
  type PlanAggregateRepository,
} from "./plan-aggregate-repository.js";
import {
  createPlanChangeRepositoryInTransaction,
  type PlanChangeRepository,
} from "./plan-change-repository.js";
import {
  createPlanCreationRepositoryInTransaction,
  type PlanCreationRepository,
} from "./plan-creation-repository.js";
import {
  claimPlanningCommandInTransaction,
  completePlanningCommandInTransaction,
  type ClaimPlanningCommandTransactionInput,
  type CompletePlanningCommandInput,
  type PlanningCommandClaim,
  type TerminalPlanningCommandRecord,
} from "./planning-command-repository.js";

export interface PlanningTransactionCommands {
  claim(input: ClaimPlanningCommandTransactionInput): Promise<PlanningCommandClaim>;
  complete(input: CompletePlanningCommandInput): Promise<TerminalPlanningCommandRecord>;
}

export interface PlanningTransaction {
  readonly commands: PlanningTransactionCommands;
  readonly plans: PlanAggregateRepository;
  readonly planCreations: PlanCreationRepository;
  readonly athleteContext: AthletePlanningContextRepository;
  readonly planChanges: PlanChangeRepository;
}

export class PlanningTransactionScopeError extends Error {
  constructor() {
    super("Planning transaction scope has ended");
    this.name = "PlanningTransactionScopeError";
  }
}

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;

export function runPlanningTransaction<T>(
  store: PlanningStore,
  operation: (transaction: PlanningTransaction) => Promise<T>,
): Promise<T> {
  return store.transaction(async () => {
    let active = true;
    const assertActive = (): void => {
      if (!active) throw new PlanningTransactionScopeError();
    };
    const scopedStore: SqlStore = {
      async exec(sql) {
        assertActive();
        await store.exec(sql);
      },
      async run(sql, params) {
        assertActive();
        await store.run(sql, params);
      },
      async get(sql, params) {
        assertActive();
        return store.get(sql, params);
      },
      async all(sql, params) {
        assertActive();
        return store.all(sql, params);
      },
      async close() {
        throw new PlanningTransactionScopeError();
      },
    };
    const transaction: PlanningTransaction = Object.freeze({
      commands: Object.freeze({
        async claim(input: ClaimPlanningCommandTransactionInput) {
          assertActive();
          return claimPlanningCommandInTransaction(scopedStore, input);
        },
        async complete(input: CompletePlanningCommandInput) {
          assertActive();
          return completePlanningCommandInTransaction(scopedStore, input);
        },
      }),
      plans: createPlanAggregateRepositoryInTransaction(scopedStore),
      planCreations: createPlanCreationRepositoryInTransaction(scopedStore),
      athleteContext: createAthletePlanningContextRepositoryInTransaction(scopedStore),
      planChanges: createPlanChangeRepositoryInTransaction(scopedStore),
    });
    try {
      return await operation(transaction);
    } finally {
      active = false;
    }
  });
}
