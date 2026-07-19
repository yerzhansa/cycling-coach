import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  SELF_TEST_CHECKSUM_ALGORITHM,
  SELF_TEST_MATRIX_CHECKSUM_FILE,
  SELF_TEST_MATRIX_FILE,
  SELF_TEST_SCHEMA_VERSION,
  SELF_TEST_TERMINAL_TYPE,
  SelfTestRpcResultSchema,
  type SelfTestRpcResult,
} from "@enduragent/coach-contract";
import { DIFFERENTIAL_OPERATIONS } from "./differential.js";

declare const METRIC_REGISTRY: Readonly<
  Record<
    string,
    {
      readonly compute: (input: {
        readonly fixture: unknown;
        readonly frozenNow: string;
      }) => unknown;
    }
  >
>;
declare const FixtureSchema: { readonly parse: (value: unknown) => unknown };
declare const mean: (values: number[]) => number;
declare const pythonSum: (values: number[]) => number;
declare const sampleStdev: (values: number[]) => number;

type MatrixFixture = {
  readonly slug: string;
  readonly frozenNow: string;
  readonly payloadSha256: string;
  readonly payload: unknown;
};

type ParityCase = {
  readonly caseId: string;
  readonly fixture: string;
  readonly metric: string;
  readonly expectedSha256: string;
  readonly expected: unknown;
  readonly ignoredActualPaths: readonly string[];
};

type DifferentialCase = {
  readonly caseId: string;
  readonly fixture: string;
  readonly streamPath: string;
  readonly op: string;
  readonly length: number;
  readonly streamSha256: string;
};

type SelfTestMatrix = {
  readonly schemaVersion: 1;
  readonly hashAlgorithm: "sha256";
  readonly fixtures: readonly MatrixFixture[];
  readonly parityCases: readonly ParityCase[];
  readonly differentialCases: readonly DifferentialCase[];
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const CHECKSUM_PATTERN = /^([a-f0-9]{64})  matrix\.json\n$/;

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function parseMatrix(value: unknown): SelfTestMatrix | undefined {
  if (
    !record(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "hashAlgorithm",
      "fixtures",
      "parityCases",
      "differentialCases",
    ]) ||
    value.schemaVersion !== 1 ||
    value.hashAlgorithm !== "sha256" ||
    !Array.isArray(value.fixtures) ||
    !Array.isArray(value.parityCases) ||
    !Array.isArray(value.differentialCases) ||
    value.fixtures.length === 0 ||
    value.parityCases.length === 0 ||
    value.differentialCases.length < 2
  ) {
    return undefined;
  }
  for (const fixture of value.fixtures) {
    if (
      !record(fixture) ||
      !exactKeys(fixture, ["slug", "frozenNow", "payloadSha256", "payload"]) ||
      !bounded(fixture.slug, 128) ||
      !bounded(fixture.frozenNow, 128) ||
      typeof fixture.payloadSha256 !== "string" ||
      !SHA256_PATTERN.test(fixture.payloadSha256)
    ) {
      return undefined;
    }
  }
  for (const item of value.parityCases) {
    if (
      !record(item) ||
      !exactKeys(item, [
        "caseId",
        "fixture",
        "metric",
        "expectedSha256",
        "expected",
        "ignoredActualPaths",
      ]) ||
      !bounded(item.caseId, 256) ||
      !bounded(item.fixture, 128) ||
      !bounded(item.metric, 128) ||
      typeof item.expectedSha256 !== "string" ||
      !SHA256_PATTERN.test(item.expectedSha256) ||
      !Array.isArray(item.ignoredActualPaths) ||
      item.ignoredActualPaths.some((path) => !bounded(path, 512))
    ) {
      return undefined;
    }
  }
  for (const item of value.differentialCases) {
    if (
      !record(item) ||
      !exactKeys(item, ["caseId", "fixture", "streamPath", "op", "length", "streamSha256"]) ||
      !bounded(item.caseId, 256) ||
      !bounded(item.fixture, 128) ||
      !bounded(item.streamPath, 512) ||
      !bounded(item.op, 128) ||
      !Number.isSafeInteger(item.length) ||
      (item.length as number) < 8 ||
      typeof item.streamSha256 !== "string" ||
      !SHA256_PATTERN.test(item.streamSha256)
    ) {
      return undefined;
    }
  }
  const fixtureSlugs = value.fixtures.map((fixture) => (fixture as MatrixFixture).slug);
  const caseIds = [
    ...value.parityCases.map((item) => (item as ParityCase).caseId),
    ...value.differentialCases.map((item) => (item as DifferentialCase).caseId),
  ];
  if (
    new Set(fixtureSlugs).size !== fixtureSlugs.length ||
    new Set(caseIds).size !== caseIds.length ||
    value.parityCases.some((item) => !fixtureSlugs.includes((item as ParityCase).fixture)) ||
    value.differentialCases.some(
      (item) => !fixtureSlugs.includes((item as DifferentialCase).fixture),
    )
  ) {
    return undefined;
  }
  return value as SelfTestMatrix;
}

function runnerError(): SelfTestRpcResult {
  return {
    schemaVersion: SELF_TEST_SCHEMA_VERSION,
    type: SELF_TEST_TERMINAL_TYPE,
    ok: false,
    error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
  };
}

function checksumMismatch(input: {
  readonly location: "asar" | "extraResources";
  readonly resource: "matrix.json" | "matrix.sha256";
  readonly expectedSha256: string;
  readonly actualSha256: string;
}): SelfTestRpcResult {
  return {
    schemaVersion: SELF_TEST_SCHEMA_VERSION,
    type: SELF_TEST_TERMINAL_TYPE,
    ok: false,
    error: {
      code: "CHECKSUM_MISMATCH",
      message: "packaged self-test resource checksum mismatch",
      ...input,
    },
  };
}

function comparisonMismatch(input: {
  readonly code: "PARITY_MISMATCH" | "DIFFERENTIAL_MISMATCH";
  readonly caseId: string;
  readonly fixture: string;
  readonly metric: string;
  readonly path: string;
}): SelfTestRpcResult {
  return {
    schemaVersion: SELF_TEST_SCHEMA_VERSION,
    type: SELF_TEST_TERMINAL_TYPE,
    ok: false,
    error: { message: "packaged self-test comparison failed", ...input },
  };
}

function mismatchPath(expected: unknown, actual: unknown, path = "$"): string | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (
    typeof expected !== typeof actual ||
    expected === null ||
    actual === null ||
    typeof expected !== "object"
  ) {
    return path;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return path;
    if (expected.length !== actual.length) return `${path}.length`;
    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = mismatchPath(expected[index], actual[index], `${path}[${index}]`);
      if (mismatch !== undefined) return mismatch;
    }
    return undefined;
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(expectedRecord), ...Object.keys(actualRecord)])].sort();
  for (const key of keys) {
    const mismatch = mismatchPath(expectedRecord[key], actualRecord[key], `${path}.${key}`);
    if (mismatch !== undefined) return mismatch;
  }
  return undefined;
}

function removePath(node: unknown, segments: readonly string[]): void {
  if (segments.length === 0 || node === null || typeof node !== "object") return;
  const [head, ...rest] = segments;
  if (head === "*") {
    for (const key of Object.keys(node)) {
      if (rest.length === 0 && !Array.isArray(node)) delete (node as Record<string, unknown>)[key];
      else removePath((node as Record<string, unknown>)[key], rest);
    }
    return;
  }
  if (Array.isArray(node)) {
    const index = Number(head);
    if (Number.isInteger(index) && index >= 0 && index < node.length) removePath(node[index], rest);
    return;
  }
  if (rest.length === 0) delete (node as Record<string, unknown>)[head!];
  else removePath((node as Record<string, unknown>)[head!], rest);
}

function stripPaths(value: unknown, paths: readonly string[]): unknown {
  if (paths.length === 0) return value;
  const copy = structuredClone(value);
  for (const path of paths)
    removePath(
      copy,
      path
        .replace(/^\$\.?/, "")
        .split(".")
        .filter(Boolean),
    );
  return copy;
}

function extractStream(payload: unknown, path: string): number[] | undefined {
  let current = payload;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return Array.isArray(current) &&
    current.every((value) => typeof value === "number" && Number.isFinite(value))
    ? current
    : undefined;
}

const implementationA = { pythonSum, mean, sampleStdev } as const;

function executeMatrix(matrix: SelfTestMatrix): SelfTestRpcResult | undefined {
  const fixtures = new Map<string, { readonly payload: unknown; readonly frozenNow: string }>();
  for (const fixture of matrix.fixtures) {
    if (hash(JSON.stringify(fixture.payload)) !== fixture.payloadSha256) return runnerError();
    const payload = FixtureSchema.parse(fixture.payload);
    fixtures.set(fixture.slug, { payload, frozenNow: fixture.frozenNow });
  }
  let parityPassed = 0;
  for (const item of matrix.parityCases) {
    if (hash(JSON.stringify(item.expected)) !== item.expectedSha256) return runnerError();
    const fixture = fixtures.get(item.fixture);
    const metric = METRIC_REGISTRY[item.metric];
    if (fixture === undefined || metric === undefined) return runnerError();
    const actual = metric.compute({ fixture: fixture.payload, frozenNow: fixture.frozenNow });
    const path = mismatchPath(item.expected, stripPaths(actual, item.ignoredActualPaths));
    if (path !== undefined) {
      return comparisonMismatch({
        code: "PARITY_MISMATCH",
        caseId: item.caseId,
        fixture: item.fixture,
        metric: item.metric,
        path,
      });
    }
    parityPassed += 1;
  }
  let differentialPassed = 0;
  for (const item of matrix.differentialCases) {
    const fixture = fixtures.get(item.fixture);
    const first = implementationA[item.op as keyof typeof implementationA];
    const second = DIFFERENTIAL_OPERATIONS[item.op as keyof typeof DIFFERENTIAL_OPERATIONS];
    if (fixture === undefined || first === undefined || second === undefined) return runnerError();
    const stream = extractStream(fixture.payload, item.streamPath);
    if (
      stream === undefined ||
      stream.length !== item.length ||
      hash(JSON.stringify(stream)) !== item.streamSha256
    ) {
      return runnerError();
    }
    if (!Object.is(first(stream), second(stream))) {
      return comparisonMismatch({
        code: "DIFFERENTIAL_MISMATCH",
        caseId: item.caseId,
        fixture: item.fixture,
        metric: item.op,
        path: item.streamPath,
      });
    }
    differentialPassed += 1;
  }
  if (parityPassed === 0 || differentialPassed === 0) return runnerError();
  return {
    schemaVersion: SELF_TEST_SCHEMA_VERSION,
    type: SELF_TEST_TERMINAL_TYPE,
    ok: true,
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron ?? "unavailable",
      v8: process.versions.v8,
    },
    resources: {
      algorithm: SELF_TEST_CHECKSUM_ALGORITHM,
      matrixSha256: "",
      insideAsarSha256: "",
      extraResourcesSha256: "",
      byteIdentical: true,
    },
    suites: {
      parity: { cases: matrix.parityCases.length, passed: parityPassed },
      differential: { cases: matrix.differentialCases.length, passed: differentialPassed },
    },
  };
}

type ResourcePair = {
  readonly location: "asar" | "extraResources";
  readonly matrix: Buffer;
  readonly checksum: Buffer;
  readonly matrixDigest: string;
  readonly checksumDigest: string;
  readonly declared: string | undefined;
  readonly valid: boolean;
};

function readPair(resourcesPath: string, location: "asar" | "extraResources"): ResourcePair {
  const root =
    location === "asar"
      ? join(resourcesPath, "app.asar", "resources", "self-test")
      : join(resourcesPath, "self-test");
  const matrix = readFileSync(join(root, SELF_TEST_MATRIX_FILE));
  const checksum = readFileSync(join(root, SELF_TEST_MATRIX_CHECKSUM_FILE));
  const matrixDigest = hash(matrix);
  const checksumDigest = hash(checksum);
  const match = CHECKSUM_PATTERN.exec(checksum.toString("utf8"));
  const declared = match?.[1];
  return {
    location,
    matrix,
    checksum,
    matrixDigest,
    checksumDigest,
    declared,
    valid: declared === matrixDigest,
  };
}

function classify(inside: ResourcePair, outside: ResourcePair): SelfTestRpcResult | undefined {
  if (inside.valid && outside.valid) {
    if (!inside.matrix.equals(outside.matrix)) {
      return checksumMismatch({
        location: "extraResources",
        resource: "matrix.json",
        expectedSha256: inside.matrixDigest,
        actualSha256: outside.matrixDigest,
      });
    }
    return undefined;
  }
  if (inside.valid === outside.valid) return runnerError();
  const valid = inside.valid ? inside : outside;
  const failing = inside.valid ? outside : inside;
  if (failing.declared === undefined || failing.matrix.equals(valid.matrix)) {
    return checksumMismatch({
      location: failing.location,
      resource: "matrix.sha256",
      expectedSha256: valid.checksumDigest,
      actualSha256: failing.checksumDigest,
    });
  }
  return checksumMismatch({
    location: failing.location,
    resource: "matrix.json",
    expectedSha256: failing.declared,
    actualSha256: failing.matrixDigest,
  });
}

export function runSelfTest(input: { readonly resourcesPath: string }): SelfTestRpcResult {
  try {
    if (!isAbsolute(input.resourcesPath)) return runnerError();
    const inside = readPair(input.resourcesPath, "asar");
    const outside = readPair(input.resourcesPath, "extraResources");
    const corruption = classify(inside, outside);
    if (corruption !== undefined) return SelfTestRpcResultSchema.parse(corruption);
    const matrix = parseMatrix(JSON.parse(inside.matrix.toString("utf8")));
    if (matrix === undefined) return runnerError();
    const result = executeMatrix(matrix);
    if (result === undefined || !result.ok) return SelfTestRpcResultSchema.parse(result);
    const digest = inside.matrixDigest;
    return SelfTestRpcResultSchema.parse({
      ...result,
      resources: {
        ...result.resources,
        matrixSha256: digest,
        insideAsarSha256: digest,
        extraResourcesSha256: outside.matrixDigest,
      },
    });
  } catch {
    return runnerError();
  }
}
