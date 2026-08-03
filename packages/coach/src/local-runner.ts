import type { CoachEngine, CoachOperations } from "@enduragent/coach-contract";
import { prepareAthleteHome, type AthleteHome } from "@enduragent/kernel-node/home";
import type { WriterProtocolListener } from "@enduragent/kernel-node/lock";
import { createLocalCoachComposition, type LocalCoachComposition } from "./composition.js";
import type { SpendMeterService } from "./spend-meter.js";
import {
  migrateLegacyHomeUnderLock,
  type LegacyMigrationAction,
  type LegacyMigrationResult,
} from "./legacy-migration.js";
import { checkHomeReadiness, type ReadinessFailure } from "./readiness.js";
import { withCoachStoreWriter } from "./runtime.js";

export interface LocalCoachLifecycle {
  readonly home: AthleteHome;
  readonly engine: CoachEngine;
  readonly operations: CoachOperations;
  readonly spendMeter: SpendMeterService;
  readonly listener: WriterProtocolListener;
  close(): Promise<void>;
}

export type LocalCoachRunResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | ReadinessFailure
  | {
      readonly status: "migration-refused";
      readonly result: Extract<LegacyMigrationResult, { status: "refused" }>;
    }
  | {
      readonly status: "migration-discarded";
      readonly result: Extract<LegacyMigrationResult, { status: "discarded" }>;
    };

export interface WithLocalCoachInput<T> {
  readonly env: Record<string, string | undefined>;
  readonly home: AthleteHome;
  readonly sourceRoot: string;
  readonly action: LegacyMigrationAction;
  readonly operation: (lifecycle: LocalCoachLifecycle) => Promise<T>;
}

type MigrationTerminalResult = Extract<LegacyMigrationResult, { status: "refused" | "discarded" }>;

class MigrationTerminal extends Error {
  constructor(readonly result: MigrationTerminalResult) {
    super("Legacy migration terminated before store open.");
  }
}

type WriterValue<T> =
  | { readonly kind: "readiness-failure"; readonly result: ReadinessFailure }
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown };

function sameHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

function migrationTerminal(error: unknown): MigrationTerminal | undefined {
  const visited = new Set<unknown>();
  let candidate = error;
  while (
    candidate !== null &&
    (typeof candidate === "object" || typeof candidate === "function") &&
    !visited.has(candidate)
  ) {
    if (candidate instanceof MigrationTerminal) return candidate;
    visited.add(candidate);
    candidate = (candidate as { readonly cause?: unknown }).cause;
  }
  return undefined;
}

function migrationResult<T>(terminal: MigrationTerminal): LocalCoachRunResult<T> {
  return terminal.result.status === "refused"
    ? { status: "migration-refused", result: terminal.result }
    : { status: "migration-discarded", result: terminal.result };
}

export async function withLocalCoach<T>(
  input: WithLocalCoachInput<T>,
): Promise<LocalCoachRunResult<T>> {
  if (typeof input.operation !== "function") {
    throw new TypeError("invalid local coach operation");
  }
  const selectedHome = await prepareAthleteHome(input.home);
  const writerEnv = { ...input.env, ENDURAGENT_HOME: selectedHome.root };
  let operationOutcome: Extract<WriterValue<T>, { kind: "rejected" }> | undefined;
  let writerValue: WriterValue<T>;
  try {
    writerValue = await withCoachStoreWriter(writerEnv, {
      beforeStoreOpen: async (resolvedHome) => {
        if (!sameHome(resolvedHome, selectedHome)) {
          throw new TypeError("Writer home does not match the selected athlete home.");
        }
        const result = await migrateLegacyHomeUnderLock({
          sourceRoot: input.sourceRoot,
          targetRoot: selectedHome.root,
          action: input.action,
        });
        if (result.status === "refused" || result.status === "discarded") {
          throw new MigrationTerminal(result);
        }
      },
      operation: async (context): Promise<WriterValue<T>> => {
        const readiness = await checkHomeReadiness(context.home);
        if (readiness.status !== "ready") {
          return {
            kind: "readiness-failure",
            result: readiness,
          };
        }
        const compositionConfig =
          readiness.config.dataDir === selectedHome.root
            ? readiness.config
            : { ...readiness.config, dataDir: selectedHome.root };
        let lifecycle: LocalCoachComposition | undefined;
        let lifecycleCloseOutcome: { kind: "succeeded" } | { kind: "failed"; error: unknown } = {
          kind: "succeeded",
        };
        let outcome: WriterValue<T>;
        try {
          lifecycle = await createLocalCoachComposition({
            env: writerEnv,
            home: selectedHome,
            context,
            config: compositionConfig,
            engineConfig: readiness.engineConfig,
          });
          const publishedLifecycle = lifecycle;
          try {
            outcome = {
              kind: "fulfilled",
              value: await input.operation({
                home: selectedHome,
                engine: publishedLifecycle.engine,
                operations: publishedLifecycle.operations,
                spendMeter: publishedLifecycle.spendMeter,
                listener: context.listener,
                close: () => publishedLifecycle.close(),
              }),
            };
          } catch (error) {
            operationOutcome = { kind: "rejected", error };
            outcome = operationOutcome;
          }
        } finally {
          if (lifecycle !== undefined) {
            try {
              await lifecycle.close();
            } catch (error) {
              lifecycleCloseOutcome = { kind: "failed", error };
            }
          }
        }
        if (lifecycleCloseOutcome.kind === "failed" && operationOutcome === undefined) {
          throw lifecycleCloseOutcome.error;
        }
        return outcome!;
      },
    });
  } catch (error) {
    const terminal = migrationTerminal(error);
    if (terminal !== undefined) return migrationResult(terminal);
    if (operationOutcome !== undefined) throw operationOutcome.error;
    throw error;
  }
  if (writerValue.kind === "rejected") throw writerValue.error;
  if (writerValue.kind === "readiness-failure") return writerValue.result;
  return { status: "completed", value: writerValue.value };
}
