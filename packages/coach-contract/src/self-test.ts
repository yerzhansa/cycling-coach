import { z } from "zod";

export const SELF_TEST_RPC_METHOD = "selfTest" as const;
export const SELF_TEST_TERMINAL_TYPE = "self-test-terminal" as const;
export const SELF_TEST_SCHEMA_VERSION = 1 as const;
export const SELF_TEST_CHECKSUM_ALGORITHM = "sha256" as const;
export const SELF_TEST_MATRIX_FILE = "matrix.json" as const;
export const SELF_TEST_MATRIX_CHECKSUM_FILE = "matrix.sha256" as const;
export const SELF_TEST_RUNNER_FILE = "self-test-runner.cjs" as const;

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const SelfTestRpcParamsSchema = z.object({}).strict();

const SuiteResultSchema = z
  .object({
    cases: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    passed: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.passed !== value.cases) {
      context.addIssue({ code: "custom", path: ["passed"], message: "all cases must pass" });
    }
  });

const SelfTestSuccessSchema = z
  .object({
    schemaVersion: z.literal(SELF_TEST_SCHEMA_VERSION),
    type: z.literal(SELF_TEST_TERMINAL_TYPE),
    ok: z.literal(true),
    runtime: z
      .object({
        node: z.string().min(1),
        electron: z.string().min(1),
        v8: z.string().min(1),
      })
      .strict(),
    resources: z
      .object({
        algorithm: z.literal(SELF_TEST_CHECKSUM_ALGORITHM),
        matrixSha256: Sha256HexSchema,
        insideAsarSha256: Sha256HexSchema,
        extraResourcesSha256: Sha256HexSchema,
        byteIdentical: z.literal(true),
      })
      .strict(),
    suites: z
      .object({
        parity: SuiteResultSchema,
        differential: SuiteResultSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const hashes = [
      value.resources.matrixSha256,
      value.resources.insideAsarSha256,
      value.resources.extraResourcesSha256,
    ];
    if (new Set(hashes).size !== 1) {
      context.addIssue({ code: "custom", path: ["resources"], message: "resource hashes differ" });
    }
  });

const ChecksumMismatchSchema = z
  .object({
    code: z.literal("CHECKSUM_MISMATCH"),
    message: z.literal("packaged self-test resource checksum mismatch"),
    location: z.enum(["asar", "extraResources"]),
    resource: z.enum([SELF_TEST_MATRIX_FILE, SELF_TEST_MATRIX_CHECKSUM_FILE]),
    expectedSha256: Sha256HexSchema,
    actualSha256: Sha256HexSchema,
  })
  .strict();

const ComparisonMismatchSchema = z
  .object({
    code: z.enum(["PARITY_MISMATCH", "DIFFERENTIAL_MISMATCH"]),
    message: z.literal("packaged self-test comparison failed"),
    caseId: z.string().min(1).max(256),
    fixture: z.string().min(1).max(128),
    metric: z.string().min(1).max(128),
    path: z.string().min(1).max(512),
  })
  .strict();

const RunnerErrorSchema = z
  .object({
    code: z.literal("RUNNER_ERROR"),
    message: z.literal("packaged self-test failed"),
  })
  .strict();

const DaemonUnavailableSchema = z
  .object({
    code: z.literal("DAEMON_UNAVAILABLE"),
    message: z.literal("Enduragent could not reach the local service."),
  })
  .strict();

const VersionMismatchSchema = z
  .object({
    code: z.literal("VERSION_MISMATCH"),
    message: z.literal("Enduragent protocol versions do not match; update this client."),
  })
  .strict();

function failureSchema<T extends z.ZodType>(error: T) {
  return z
    .object({
      schemaVersion: z.literal(SELF_TEST_SCHEMA_VERSION),
      type: z.literal(SELF_TEST_TERMINAL_TYPE),
      ok: z.literal(false),
      error,
    })
    .strict();
}

export const SelfTestRpcResultSchema = z.union([
  SelfTestSuccessSchema,
  failureSchema(ChecksumMismatchSchema),
  failureSchema(ComparisonMismatchSchema),
  failureSchema(RunnerErrorSchema),
]);
export type SelfTestRpcResult = z.infer<typeof SelfTestRpcResultSchema>;

export const SelfTestCommandTerminalSchema = z.union([
  SelfTestRpcResultSchema,
  failureSchema(DaemonUnavailableSchema),
  failureSchema(VersionMismatchSchema),
]);
export type SelfTestCommandTerminal = z.infer<typeof SelfTestCommandTerminalSchema>;
