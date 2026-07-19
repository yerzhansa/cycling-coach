import { engineConfigFromConfig, loadConfig } from "@enduragent/core";
import type { CoachEngine, CoachOperations } from "@enduragent/coach-contract";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import type { WriterProtocolListener } from "@enduragent/kernel-node/lock";
import { createLocalCoachComposition, type LocalCoachComposition } from "./composition.js";
import {
  migrateLegacyHomeUnderLock,
  type LegacyMigrationAction,
  type LegacyMigrationResult,
} from "./legacy-migration.js";
import { checkHomeReadiness } from "./readiness.js";
import { withCoachStoreWriter } from "./runtime.js";

export interface LocalCoachLifecycle {
  readonly engine: CoachEngine;
  readonly operations: CoachOperations;
  readonly listener: WriterProtocolListener;
  close(): Promise<void>;
}

export type LocalCoachRunResult<T> =
  | { readonly status: "completed"; readonly value: T }
  | { readonly status: "not-configured"; readonly configPath: string }
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
  | { readonly kind: "not-configured"; readonly configPath: string }
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
  const writerEnv = { ...input.env, ENDURAGENT_HOME: input.home.root };
  let operationOutcome: Extract<WriterValue<T>, { kind: "rejected" }> | undefined;
  let writerValue: WriterValue<T>;
  try {
    writerValue = await withCoachStoreWriter(writerEnv, {
      beforeStoreOpen: async (resolvedHome) => {
        if (!sameHome(resolvedHome, input.home)) {
          throw new TypeError("Writer home does not match the selected athlete home.");
        }
        const result = await migrateLegacyHomeUnderLock({
          sourceRoot: input.sourceRoot,
          targetRoot: input.home.root,
          action: input.action,
        });
        if (result.status === "refused" || result.status === "discarded") {
          throw new MigrationTerminal(result);
        }
      },
      operation: async (context): Promise<WriterValue<T>> => {
        const readiness = await checkHomeReadiness(context.home);
        if (readiness.status === "not-configured") {
          return {
            kind: "not-configured",
            configPath: readiness.configPath,
          };
        }
        const config = loadConfig(context.home.configDir);
        if (JSON.stringify(engineConfigFromConfig(config)) !== JSON.stringify(readiness.config)) {
          throw new TypeError("Ready engine configuration changed before engine construction.");
        }
        let lifecycle: LocalCoachComposition | undefined;
        let lifecycleCloseOutcome: { kind: "succeeded" } | { kind: "failed"; error: unknown } = {
          kind: "succeeded",
        };
        let outcome: WriterValue<T>;
        try {
          lifecycle = await createLocalCoachComposition({
            env: writerEnv,
            home: input.home,
            context,
            config,
            engineConfig: readiness.config,
          });
          const publishedLifecycle = lifecycle;
          try {
            outcome = {
              kind: "fulfilled",
              value: await input.operation({
                engine: publishedLifecycle.engine,
                operations: publishedLifecycle.operations,
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
  if (writerValue.kind === "not-configured") {
    return { status: "not-configured", configPath: writerValue.configPath };
  }
  return { status: "completed", value: writerValue.value };
}
