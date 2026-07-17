import {
  runCoachDevWriter,
  type CoachDevWriterContext,
  type CoachDevWriterFailureStage,
} from "@enduragent/kernel-node/coach-dev";

export type CoachStoreWriterContext = CoachDevWriterContext;

export type CoachStoreWriterErrorCode = "writer-lock-held" | "writer-failed";

export class CoachStoreWriterError extends Error {
  readonly code: CoachStoreWriterErrorCode;
  readonly stage: CoachDevWriterFailureStage | null;

  constructor(code: CoachStoreWriterErrorCode, stage: CoachDevWriterFailureStage | null) {
    super(
      code === "writer-lock-held"
        ? "coach store writer is already active"
        : `coach store writer failed at ${stage}`,
    );
    this.name = "CoachStoreWriterError";
    this.code = code;
    this.stage = stage;
  }
}

export interface CoachRuntimeDependencies {
  readonly runWriter: typeof runCoachDevWriter;
}

const defaultDependencies: CoachRuntimeDependencies = Object.freeze({
  runWriter: runCoachDevWriter,
});

export async function withCoachStoreWriter<T>(
  env: Record<string, string | undefined>,
  operation: (context: CoachStoreWriterContext) => Promise<T>,
  deps?: CoachRuntimeDependencies,
): Promise<T> {
  if (typeof operation !== "function") {
    throw new TypeError("invalid coach writer operation");
  }

  const dependencies = deps ?? defaultDependencies;
  const result = await dependencies.runWriter({
    env,
    writerVersion: "coach-sync/1",
    operation,
  });

  if (result.status === "completed") return result.value;
  if (result.status === "writer-lock-held") {
    throw new CoachStoreWriterError("writer-lock-held", null);
  }
  throw new CoachStoreWriterError("writer-failed", result.stage);
}
