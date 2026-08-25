import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createPlanRepository,
  legacyPlanRows,
  type PlanRepository,
  type PlanningIdentity,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { AthleteHome } from "../home/resolve-athlete-home.js";
import type { AuthoredIdentity } from "../store/authored-identity.js";

export const LEGACY_PLAN_IMPORT_MARKER = "planning-current-plan-import-v1" as const;

export interface LegacyPlanImportLogger {
  warn(message: string): void;
}

export type LegacyPlanImportResult =
  | { readonly status: "imported"; readonly planId: string }
  | { readonly status: "already-completed" | "no-source" | "malformed" };

type PlanningStore = SqlStore & Pick<MigratorStore, "transaction">;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as { readonly code?: string }).code
    : undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function markCompleted(path: string): Promise<void> {
  try {
    await writeFile(path, "completed\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

async function planningIdentity(identity: AuthoredIdentity): Promise<PlanningIdentity> {
  const deviceId = await identity.deviceId();
  return Object.freeze({
    deviceId,
    newId: () => identity.newUlid(),
    stamp: () => identity.hlcStamp(),
  });
}

export async function importLegacyCurrentPlan(input: {
  readonly home: AthleteHome;
  readonly store: PlanningStore;
  readonly identity: AuthoredIdentity;
  readonly importDateKey: number;
  readonly importTimestampMs: number;
  readonly logger: LegacyPlanImportLogger;
}): Promise<LegacyPlanImportResult> {
  const markerPath = join(input.home.configDir, LEGACY_PLAN_IMPORT_MARKER);
  if (await exists(markerPath)) return { status: "already-completed" };
  const sourcePath = join(input.home.root, "plans", "current-plan.json");
  let sourceBytes: Buffer;
  try {
    sourceBytes = await readFile(sourcePath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await mkdir(input.home.configDir, { recursive: true, mode: 0o700 });
    await markCompleted(markerPath);
    return { status: "no-source" };
  }
  let value: unknown;
  try {
    value = JSON.parse(sourceBytes.toString("utf8"));
  } catch {
    input.logger.warn("Legacy Plan import skipped because the source is malformed.");
    return { status: "malformed" };
  }
  const repository = createPlanRepository(input.store);
  let rows;
  try {
    const originId = typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && typeof (value as { readonly id?: unknown }).id === "string"
      ? (value as { readonly id: string }).id
      : undefined;
    const existing = originId === undefined ? undefined : await repository.readByOriginId(originId);
    rows = legacyPlanRows({
      value,
      identity: await planningIdentity(input.identity),
      fallbackDateKey: input.importDateKey,
      fallbackTimestampMs: input.importTimestampMs,
      ...(existing === undefined ? {} : { existingPlanId: existing.id }),
    });
    await repository.replace(rows.plan, rows.workouts);
  } catch {
    input.logger.warn("Legacy Plan import skipped because the source is malformed.");
    return { status: "malformed" };
  }
  await mkdir(input.home.configDir, { recursive: true, mode: 0o700 });
  await markCompleted(markerPath);
  return { status: "imported", planId: rows.plan.id };
}

export async function createLegacyPlanRowWriter(input: {
  readonly repository: PlanRepository;
  readonly identity: AuthoredIdentity;
  readonly fallbackDateKey: () => number;
  readonly now: () => number;
}): Promise<(value: unknown) => Promise<void>> {
  const identity = await planningIdentity(input.identity);
  let currentPlanId: string | undefined;
  return async (value: unknown): Promise<void> => {
    const todayDateKey = input.fallbackDateKey();
    const originId = typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && typeof (value as { readonly id?: unknown }).id === "string"
      ? (value as { readonly id: string }).id
      : undefined;
    const existing = originId === undefined
      ? currentPlanId === undefined
        ? await input.repository.readLatest()
        : await input.repository.read(currentPlanId)
      : await input.repository.readByOriginId(originId);
    const rows = legacyPlanRows({
      value,
      identity,
      fallbackDateKey: todayDateKey,
      fallbackTimestampMs: input.now(),
      ...(existing === undefined ? {} : { existingPlanId: existing.id }),
    });
    if (existing === undefined) {
      await input.repository.replaceNew(rows.plan, rows.workouts, todayDateKey);
    } else {
      await input.repository.replace(rows.plan, rows.workouts);
    }
    currentPlanId = rows.plan.id;
  };
}

export function createLegacyPlanRepository(store: PlanningStore): PlanRepository {
  return createPlanRepository(store);
}
