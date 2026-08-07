#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DESKTOP_FEED_URL = "https://github.com/yerzhansa/enduragent/releases/latest/download/";
export const DESKTOP_MANIFEST = "desktop-release-manifest.json";
export const DESKTOP_RELEASE_SCHEMA_VERSION = 1 as const;

export type DesktopReleaseMode = "steady" | "genesis";

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const sha512Base64Schema = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u);

const DesktopReleaseFileSchema = z
  .object({
    name: z.string(),
    size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    sha256: sha256HexSchema,
    sha512: sha512Base64Schema,
  })
  .strict();

const DesktopReleaseManifestSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_RELEASE_SCHEMA_VERSION),
    tag: z.string(),
    version: z.string(),
    commit: z.string(),
    draftId: z.string(),
    mode: z.enum(["steady", "genesis"]),
    feedUrl: z.literal(DESKTOP_FEED_URL),
    workflowRunId: z.string(),
    workflowRunAttempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    draftBodySha256: sha256HexSchema,
    npmIntegrity: z.string(),
    npmAttestationUrl: z.string(),
    signingIdentity: z.string(),
    candidateCdHash: z.string(),
    candidateCodeDirectorySha256: sha256HexSchema,
    baselineTag: z.string(),
    baselineReleaseId: z.string(),
    baselineCommit: z.string(),
    baselineZipSha256: z.string(),
    baselineSigningIdentity: z.string(),
    baselineCdHash: z.string(),
    transactionSha256: sha256HexSchema,
    files: z.array(DesktopReleaseFileSchema),
  })
  .strict();

export type DesktopReleaseFile = z.infer<typeof DesktopReleaseFileSchema>;
export type DesktopReleaseManifest = z.infer<typeof DesktopReleaseManifestSchema>;

interface GithubAsset {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly state: "starter" | "uploaded";
  readonly url: string;
  readonly browser_download_url: string;
}

interface GithubRelease {
  readonly id: number;
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly GithubAsset[];
  readonly upload_url: string;
  readonly body: string;
}

interface GithubReference {
  readonly object: { readonly type: "commit" | "tag"; readonly sha: string };
}

interface GithubTag {
  readonly object: { readonly type: "commit" | "tag"; readonly sha: string };
}

export interface LatestObservation {
  readonly id: number | null;
  readonly tag: string | null;
  readonly metadataSha256: string | null;
}

export interface NpmAttestationExpectation {
  readonly name: string;
  readonly version: string;
  readonly integrity: string;
  readonly repository: string;
  readonly workflow: string;
  readonly ref: string;
  readonly commit: string;
  readonly invocationId: string;
  readonly allowPriorInvocation?: boolean;
  readonly releaseTag: string;
  readonly eventName: string;
  readonly repositoryId: string;
  readonly repositoryOwnerId: string;
}

export interface NpmProvenanceIdentity {
  readonly issuer: "https://token.actions.githubusercontent.com";
  readonly uri: string;
}

export type NpmProvenanceBundleVerifier = (
  bundle: Record<string, unknown>,
  identity: NpmProvenanceIdentity,
) => Promise<void>;

const versionPattern = /^([1-9]\d{3})\.([1-9]|1[0-2])\.(0|[1-9]\d*)$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const signingIdentityPattern = /^Developer ID Application: .+ \(FA494ACVTF\)$/u;

function exactObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function requireVersion(value: unknown): string {
  if (typeof value !== "string" || !versionPattern.test(value)) {
    throw new TypeError("desktop release version is invalid");
  }
  return value;
}

export function requireMode(value: unknown): DesktopReleaseMode {
  if (value !== "steady" && value !== "genesis") {
    throw new TypeError("desktop release mode is invalid");
  }
  return value;
}

export function releaseFileNames(version: string): readonly [string, string, string, string] {
  const stableVersion = requireVersion(version);
  const base = `Enduragent-${stableVersion}-arm64`;
  return [`${base}.dmg`, `${base}.zip`, `${base}.zip.blockmap`, "latest-mac.yml"];
}

function requireBinding(input: {
  tag: unknown;
  version: unknown;
  commit: unknown;
  draftId: unknown;
  mode: unknown;
  workflowRunId?: unknown;
  workflowRunAttempt?: unknown;
  draftBodySha256?: unknown;
  npmIntegrity?: unknown;
  npmAttestationUrl?: unknown;
  signingIdentity?: unknown;
  candidateCdHash?: unknown;
  candidateCodeDirectorySha256?: unknown;
  baselineTag?: unknown;
  baselineReleaseId?: unknown;
  baselineCommit?: unknown;
  baselineZipSha256?: unknown;
  baselineSigningIdentity?: unknown;
  baselineCdHash?: unknown;
}): Omit<DesktopReleaseManifest, "schemaVersion" | "feedUrl" | "files" | "transactionSha256"> {
  const version = requireVersion(input.version);
  const tag = `cycling-coach@${version}`;
  if (input.tag !== tag) throw new TypeError("desktop release tag and version do not match");
  if (typeof input.commit !== "string" || !commitPattern.test(input.commit)) {
    throw new TypeError("desktop release commit is invalid");
  }
  if (typeof input.draftId !== "string" || !/^[1-9]\d*$/u.test(input.draftId)) {
    throw new TypeError("desktop release draft id is invalid");
  }
  if (typeof input.workflowRunId !== "string" || !/^[1-9]\d*$/u.test(input.workflowRunId))
    throw new TypeError("workflow run id is invalid");
  const workflowRunAttempt = Number(input.workflowRunAttempt);
  if (!Number.isSafeInteger(workflowRunAttempt) || workflowRunAttempt < 1)
    throw new TypeError("workflow run attempt is invalid");
  if (typeof input.draftBodySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(input.draftBodySha256))
    throw new TypeError("draft body hash is invalid");
  if (typeof input.candidateCdHash !== "string" || !/^[0-9a-f]{40}$/u.test(input.candidateCdHash))
    throw new TypeError("candidate CDHash is invalid");
  if (
    typeof input.candidateCodeDirectorySha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(input.candidateCodeDirectorySha256)
  )
    throw new TypeError("candidate CodeDirectory hash is invalid");
  if (
    typeof input.npmIntegrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(input.npmIntegrity)
  )
    throw new TypeError("npm integrity is invalid");
  if (
    typeof input.npmAttestationUrl !== "string" ||
    input.npmAttestationUrl !==
      `https://registry.npmjs.org/-/npm/v1/attestations/cycling-coach@${version}`
  )
    throw new TypeError("npm attestation URL is invalid");
  if (
    typeof input.signingIdentity !== "string" ||
    !signingIdentityPattern.test(input.signingIdentity)
  )
    throw new TypeError("signing identity is invalid");
  const baselineTag = typeof input.baselineTag === "string" ? input.baselineTag : "";
  const mode = requireMode(input.mode);
  const baselineEvidence = [
    input.baselineReleaseId,
    input.baselineCommit,
    input.baselineZipSha256,
    input.baselineSigningIdentity,
    input.baselineCdHash,
  ];
  if (
    mode === "genesis"
      ? baselineTag !== "none" || baselineEvidence.some((value) => value !== "none")
      : !baselineTag.startsWith("cycling-coach@")
  )
    throw new TypeError("baseline evidence is invalid");
  if (
    mode === "steady" &&
    (typeof input.baselineReleaseId !== "string" ||
      !/^[1-9]\d*$/u.test(input.baselineReleaseId) ||
      typeof input.baselineCommit !== "string" ||
      !commitPattern.test(input.baselineCommit) ||
      typeof input.baselineZipSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(input.baselineZipSha256) ||
      typeof input.baselineSigningIdentity !== "string" ||
      !signingIdentityPattern.test(input.baselineSigningIdentity) ||
      typeof input.baselineCdHash !== "string" ||
      !/^[0-9a-f]{40}$/u.test(input.baselineCdHash))
  )
    throw new TypeError("steady baseline evidence is invalid");
  return {
    tag,
    version,
    commit: input.commit,
    draftId: input.draftId,
    mode,
    workflowRunId: input.workflowRunId,
    workflowRunAttempt,
    draftBodySha256: input.draftBodySha256 as string,
    npmIntegrity: input.npmIntegrity,
    npmAttestationUrl: input.npmAttestationUrl,
    signingIdentity: input.signingIdentity,
    candidateCdHash: input.candidateCdHash as string,
    candidateCodeDirectorySha256: input.candidateCodeDirectorySha256 as string,
    baselineTag,
    baselineReleaseId: input.baselineReleaseId as string,
    baselineCommit: input.baselineCommit as string,
    baselineZipSha256: input.baselineZipSha256 as string,
    baselineSigningIdentity: input.baselineSigningIdentity as string,
    baselineCdHash: input.baselineCdHash as string,
  };
}

async function stableFile(path: string): Promise<{ bytes: Buffer; size: number }> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
    throw new TypeError(`invalid release file: ${basename(path)}`);
  }
  const bytes = await readFile(path);
  const after = await lstat(path);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.mode !== after.mode ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    bytes.length !== before.size
  ) {
    throw new TypeError(`unstable release file: ${basename(path)}`);
  }
  return { bytes, size: before.size };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha512(bytes: Uint8Array): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!exactObject(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

export function inspectNpmAttestationClaims(
  metadata: unknown,
  expected: NpmAttestationExpectation,
): { bundle: Record<string, unknown>; workflowRef: string } {
  const document = requireRecord(metadata, "npm attestation document");
  const attestations = requireArray(document.attestations, "npm attestations");
  const types = [
    "https://slsa.dev/provenance/v1",
    "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
  ] as const;
  const statementTypes = new Map<string, string>([
    [types[0], "https://in-toto.io/Statement/v1"],
    [types[1], "https://in-toto.io/Statement/v0.1"],
  ]);
  const expectedPurl = `pkg:npm/${expected.name}@${expected.version}`;
  const integrityMatch = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(expected.integrity);
  if (!integrityMatch) throw new TypeError("expected npm integrity is invalid");
  const expectedHex = Buffer.from(integrityMatch[1], "base64").toString("hex");
  const statements = new Map<string, Record<string, unknown>>();
  const bundles = new Map<string, Record<string, unknown>>();
  for (const raw of attestations) {
    const attestation = requireRecord(raw, "npm attestation");
    if (typeof attestation.predicateType !== "string")
      throw new TypeError("npm attestation predicate type is invalid");
    const bundle = requireRecord(attestation.bundle, "npm attestation bundle");
    const envelope = requireRecord(bundle.dsseEnvelope, "npm DSSE envelope");
    if (typeof envelope.payload !== "string") throw new TypeError("npm DSSE payload is invalid");
    let statement: unknown;
    try {
      statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8"));
    } catch {
      throw new TypeError("npm DSSE statement is invalid");
    }
    const decoded = requireRecord(statement, "npm DSSE statement");
    if (!types.includes(attestation.predicateType as (typeof types)[number])) {
      const subjects = Array.isArray(decoded.subject) ? decoded.subject : [];
      if (subjects.some((subject) => exactObject(subject) && subject.name === expectedPurl))
        throw new TypeError("unexpected npm attestation predicate for release subject");
      continue;
    }
    if (statements.has(attestation.predicateType))
      throw new TypeError("duplicate npm attestation predicate");
    statements.set(attestation.predicateType, decoded);
    bundles.set(attestation.predicateType, bundle);
  }
  if (statements.size !== types.length)
    throw new TypeError("required npm attestations are missing");
  for (const type of types) {
    const statement = statements.get(type)!;
    if (statement._type !== statementTypes.get(type) || statement.predicateType !== type)
      throw new TypeError("npm attestation statement type is invalid");
    const matchingSubjects = requireArray(statement.subject, "npm attestation subjects").filter(
      (subject) => {
        if (!exactObject(subject) || subject.name !== expectedPurl || !exactObject(subject.digest))
          return false;
        return subject.digest.sha512 === expectedHex;
      },
    );
    if (matchingSubjects.length !== 1)
      throw new TypeError("npm attestation subject digest binding is invalid");
  }
  const provenance = requireRecord(statements.get(types[0])!.predicate, "npm provenance predicate");
  const definition = requireRecord(provenance.buildDefinition, "npm provenance build definition");
  const internal = requireRecord(
    definition.internalParameters,
    "npm provenance internal parameters",
  );
  const githubInternal = requireRecord(internal.github, "npm provenance GitHub parameters");
  const external = requireRecord(
    definition.externalParameters,
    "npm provenance external parameters",
  );
  const workflow = requireRecord(external.workflow, "npm provenance workflow");
  const workflowRef = typeof workflow.ref === "string" ? workflow.ref : "";
  if (workflow.repository !== expected.repository)
    throw new TypeError("npm provenance repository rename boundary requires a new release version");
  const dependencies = requireArray(
    definition.resolvedDependencies,
    "npm provenance resolved dependencies",
  );
  const matchingDependencies = dependencies.filter((dependency) => {
    if (!exactObject(dependency) || !exactObject(dependency.digest)) return false;
    return (
      dependency.digest.gitCommit === expected.commit &&
      dependency.uri === `git+${expected.repository}@${workflowRef}`
    );
  });
  const runDetails = requireRecord(provenance.runDetails, "npm provenance run details");
  const builder = requireRecord(runDetails.builder, "npm provenance builder");
  const runMetadata = requireRecord(runDetails.metadata, "npm provenance run metadata");
  const eventNameMatches =
    expected.allowPriorInvocation === true && workflowRef === `refs/tags/${expected.releaseTag}`
      ? githubInternal.event_name === "push" || githubInternal.event_name === "workflow_dispatch"
      : githubInternal.event_name === expected.eventName;
  if (
    definition.buildType !==
      "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1" ||
    workflow.repository !== expected.repository ||
    workflow.path !== expected.workflow ||
    (workflowRef !== expected.ref &&
      (!expected.allowPriorInvocation || workflowRef !== `refs/tags/${expected.releaseTag}`)) ||
    matchingDependencies.length !== 1 ||
    !eventNameMatches ||
    githubInternal.repository_id !== expected.repositoryId ||
    githubInternal.repository_owner_id !== expected.repositoryOwnerId ||
    builder.id !== "https://github.com/actions/runner/github-hosted" ||
    (expected.allowPriorInvocation
      ? typeof runMetadata.invocationId !== "string" ||
        !new RegExp(
          `^${expected.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/actions/runs/[1-9]\\d*/attempts/[1-9]\\d*$`,
          "u",
        ).test(runMetadata.invocationId)
      : runMetadata.invocationId !== expected.invocationId)
  )
    throw new TypeError("npm provenance workflow binding is invalid");
  const publish = requireRecord(statements.get(types[1])!.predicate, "npm publish predicate");
  if (
    publish.name !== expected.name ||
    publish.version !== expected.version ||
    publish.registry !== "https://registry.npmjs.org"
  )
    throw new TypeError("npm publish attestation binding is invalid");
  return { bundle: bundles.get(types[0])!, workflowRef };
}

export async function verifyNpmProvenanceBundle(
  metadata: unknown,
  expected: NpmAttestationExpectation,
  verifyBundle: NpmProvenanceBundleVerifier,
): Promise<void> {
  const { bundle, workflowRef } = inspectNpmAttestationClaims(metadata, expected);
  await verifyBundle(bundle, {
    issuer: "https://token.actions.githubusercontent.com",
    uri: `${expected.repository}/${expected.workflow}@${workflowRef}`,
  });
}

function requireMetadata(
  bytes: Buffer,
  version: string,
  files: ReadonlyMap<string, { bytes: Buffer; size: number }>,
): void {
  const value: unknown = parseYaml(bytes.toString("utf8"));
  if (
    !exactObject(value) ||
    !exactKeys(value, ["version", "files", "path", "sha512", "releaseDate"]) ||
    value.version !== version ||
    !Array.isArray(value.files) ||
    value.files.length !== 2 ||
    typeof value.releaseDate !== "string" ||
    !Number.isFinite(Date.parse(value.releaseDate)) ||
    new Date(Date.parse(value.releaseDate)).toISOString() !== value.releaseDate
  ) {
    throw new TypeError("latest-mac.yml is invalid");
  }
  const expected = releaseFileNames(version);
  const zip = files.get(expected[1]);
  const dmg = files.get(expected[0]);
  if (!zip || !dmg || value.path !== expected[1] || value.sha512 !== sha512(zip.bytes)) {
    throw new TypeError("latest-mac.yml is not bound to the release ZIP");
  }
  for (const [index, [name, file]] of (
    [
      [expected[1], zip],
      [expected[0], dmg],
    ] as const
  ).entries()) {
    const entry = value.files[index];
    if (
      !exactObject(entry) ||
      !exactKeys(entry, ["url", "sha512", "size"]) ||
      entry.url !== name ||
      entry.sha512 !== sha512(file.bytes) ||
      entry.size !== file.size ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0
    ) {
      throw new TypeError(`latest-mac.yml is not bound to ${name}`);
    }
  }
}

export async function sealDesktopRelease(
  directory: string,
  bindingInput: Parameters<typeof requireBinding>[0],
): Promise<DesktopReleaseManifest> {
  const binding = requireBinding(bindingInput);
  const expected = releaseFileNames(binding.version);
  const entries = (await readdir(directory)).sort();
  if (entries.length !== expected.length || expected.some((name) => !entries.includes(name))) {
    throw new TypeError("release envelope must contain exactly four updater files before sealing");
  }
  const snapshots = new Map<string, { bytes: Buffer; size: number }>();
  for (const name of expected) snapshots.set(name, await stableFile(resolve(directory, name)));
  requireMetadata(snapshots.get(expected[3])!.bytes, binding.version, snapshots);
  const files = expected.map((name) => {
    const snapshot = snapshots.get(name)!;
    return {
      name,
      size: snapshot.size,
      sha256: sha256(snapshot.bytes),
      sha512: sha512(snapshot.bytes),
    };
  });
  const transactionSha256 = sha256(
    Buffer.from(JSON.stringify({ ...binding, feedUrl: DESKTOP_FEED_URL, files })),
  );
  const manifest: DesktopReleaseManifest = {
    schemaVersion: DESKTOP_RELEASE_SCHEMA_VERSION,
    ...binding,
    feedUrl: DESKTOP_FEED_URL,
    files,
    transactionSha256,
  };
  await writeFile(resolve(directory, DESKTOP_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

function parseManifest(value: unknown): DesktopReleaseManifest {
  let manifest: DesktopReleaseManifest;
  try {
    manifest = DesktopReleaseManifestSchema.parse(value);
  } catch (cause) {
    throw new TypeError("desktop release manifest is invalid", { cause });
  }
  const binding = requireBinding({
    tag: manifest.tag,
    version: manifest.version,
    commit: manifest.commit,
    draftId: manifest.draftId,
    mode: manifest.mode,
    workflowRunId: manifest.workflowRunId,
    workflowRunAttempt: manifest.workflowRunAttempt,
    draftBodySha256: manifest.draftBodySha256,
    npmIntegrity: manifest.npmIntegrity,
    npmAttestationUrl: manifest.npmAttestationUrl,
    signingIdentity: manifest.signingIdentity,
    candidateCdHash: manifest.candidateCdHash,
    candidateCodeDirectorySha256: manifest.candidateCodeDirectorySha256,
    baselineTag: manifest.baselineTag,
    baselineReleaseId: manifest.baselineReleaseId,
    baselineCommit: manifest.baselineCommit,
    baselineZipSha256: manifest.baselineZipSha256,
    baselineSigningIdentity: manifest.baselineSigningIdentity,
    baselineCdHash: manifest.baselineCdHash,
  });
  const expected = releaseFileNames(binding.version);
  if (manifest.files.length !== expected.length)
    throw new TypeError("desktop release manifest file set is invalid");
  for (const [index, file] of manifest.files.entries()) {
    if (file.name !== expected[index]) {
      throw new TypeError("desktop release manifest file entry is invalid");
    }
  }
  const transactionSha256 = sha256(
    Buffer.from(JSON.stringify({ ...binding, feedUrl: DESKTOP_FEED_URL, files: manifest.files })),
  );
  if (manifest.transactionSha256 !== transactionSha256)
    throw new TypeError("desktop release transaction hash is invalid");
  return manifest;
}

export async function verifyDesktopRelease(
  directory: string,
  expectedBinding?: Parameters<typeof requireBinding>[0],
): Promise<DesktopReleaseManifest> {
  const names = (await readdir(directory)).sort();
  const manifestBytes = await stableFile(resolve(directory, DESKTOP_MANIFEST));
  let decoded: unknown;
  try {
    decoded = JSON.parse(manifestBytes.bytes.toString("utf8"));
  } catch {
    throw new TypeError("desktop release manifest is invalid JSON");
  }
  const manifest = parseManifest(decoded);
  const expectedNames = [...releaseFileNames(manifest.version), DESKTOP_MANIFEST].sort();
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  ) {
    throw new TypeError("sealed release envelope contains unexpected files");
  }
  if (expectedBinding) {
    const expected = requireBinding(expectedBinding);
    for (const key of [
      "tag",
      "version",
      "commit",
      "draftId",
      "mode",
      "workflowRunId",
      "workflowRunAttempt",
      "draftBodySha256",
      "npmIntegrity",
      "npmAttestationUrl",
      "signingIdentity",
      "candidateCdHash",
      "candidateCodeDirectorySha256",
      "baselineTag",
      "baselineReleaseId",
      "baselineCommit",
      "baselineZipSha256",
      "baselineSigningIdentity",
      "baselineCdHash",
    ] as const) {
      if (manifest[key] !== expected[key])
        throw new TypeError(`desktop release manifest ${key} mismatch`);
    }
  }
  const snapshots = new Map<string, { bytes: Buffer; size: number }>();
  for (const file of manifest.files) {
    const snapshot = await stableFile(resolve(directory, file.name));
    if (
      snapshot.size !== file.size ||
      sha256(snapshot.bytes) !== file.sha256 ||
      sha512(snapshot.bytes) !== file.sha512
    ) {
      throw new TypeError(`desktop release file digest mismatch: ${file.name}`);
    }
    snapshots.set(file.name, snapshot);
  }
  requireMetadata(snapshots.get("latest-mac.yml")!.bytes, manifest.version, snapshots);
  return manifest;
}

export async function materializeDesktopPublicEnvelope(
  directory: string,
  output: string,
): Promise<DesktopReleaseManifest> {
  const source = resolve(directory);
  const target = resolve(output);
  const targetFromSource = relative(source, target);
  if (
    targetFromSource === "" ||
    (targetFromSource !== ".." && !targetFromSource.startsWith(`..${sep}`))
  ) {
    throw new TypeError("public envelope must be outside the sealed release envelope");
  }
  const manifest = await verifyDesktopRelease(source);
  await mkdir(target, { mode: 0o700 });
  for (const file of manifest.files) {
    const destination = resolve(target, file.name);
    await link(resolve(source, file.name), destination);
    const snapshot = await stableFile(destination);
    if (
      snapshot.size !== file.size ||
      sha256(snapshot.bytes) !== file.sha256 ||
      sha512(snapshot.bytes) !== file.sha512
    ) {
      throw new TypeError(`public envelope file digest mismatch: ${file.name}`);
    }
  }
  const names = (await readdir(target)).sort();
  const expected = [...releaseFileNames(manifest.version)].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new TypeError("public envelope must contain exactly four updater files");
  }
  return manifest;
}

export function assertPublishableAssets(
  existing: readonly Pick<GithubAsset, "name">[],
  manifest: DesktopReleaseManifest,
): void {
  const allowed = new Set(manifest.files.map((file) => file.name));
  const duplicate = existing.find(
    (asset, index) => existing.findIndex((other) => other.name === asset.name) !== index,
  );
  if (duplicate) throw new TypeError(`duplicate release asset: ${duplicate.name}`);
  const stale = existing.find((asset) => !allowed.has(asset.name));
  if (stale) throw new TypeError(`stale release asset: ${stale.name}`);
}

export function assertReleaseMode(mode: DesktopReleaseMode, baselineVersion: string | null): void {
  if (mode === "genesis" && baselineVersion !== null) {
    throw new TypeError("genesis release refused after a desktop baseline exists");
  }
  if (mode === "steady" && baselineVersion === null) {
    throw new TypeError("steady release requires a desktop baseline");
  }
}

async function assertResolvedBaseline(
  manifest: DesktopReleaseManifest,
  baseline: Awaited<ReturnType<typeof newestDesktopRelease>>,
  client: GithubClient,
): Promise<void> {
  assertReleaseMode(manifest.mode, baseline?.version ?? null);
  if (manifest.mode === "genesis") return;
  const baselineZipName = baseline ? releaseFileNames(baseline.version)[1] : "";
  const baselineZipAsset = baseline?.release.assets.find((asset) => asset.name === baselineZipName);
  const baselineZipBytes = baselineZipAsset ? await client.bytes(baselineZipAsset.url) : null;
  if (
    !baseline ||
    compareVersions(baseline.version, manifest.version) >= 0 ||
    manifest.baselineTag !== baseline.release.tag_name ||
    manifest.baselineReleaseId !== String(baseline.release.id) ||
    manifest.baselineCommit !== baseline.commit ||
    !baselineZipAsset ||
    !baselineZipBytes ||
    baselineZipAsset.size !== baselineZipBytes.length ||
    manifest.baselineZipSha256 !== sha256(baselineZipBytes)
  ) {
    throw new TypeError("desktop release baseline binding mismatch");
  }
}

export function assertRemoteAsset(file: DesktopReleaseFile, bytes: Uint8Array): void {
  if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
    throw new TypeError(`conflicting release asset: ${file.name}`);
  }
}

export function compareVersions(left: string, right: string): number {
  const a = requireVersion(left).split(".").map(Number);
  const b = requireVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

export function assertLatestCas(
  candidateVersion: string,
  observed: LatestObservation,
  current: LatestObservation,
  previousDesktopVersion: string | null,
): void {
  if (
    observed.id !== current.id ||
    observed.tag !== current.tag ||
    observed.metadataSha256 !== current.metadataSha256
  ) {
    throw new TypeError("repository latest changed after publication observation");
  }
  if (
    previousDesktopVersion !== null &&
    compareVersions(candidateVersion, previousDesktopVersion) <= 0
  ) {
    throw new TypeError("desktop latest promotion is not monotonic");
  }
}

export type DesktopReleaseFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class GithubClient {
  readonly #repository: string;
  readonly #token: string;
  readonly #fetch: DesktopReleaseFetch;

  constructor(repository: string, token: string, fetchImplementation: DesktopReleaseFetch = fetch) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository))
      throw new TypeError("GitHub repository is invalid");
    if (token.length === 0) throw new TypeError("GitHub token is missing");
    this.#repository = repository;
    this.#token = token;
    this.#fetch = fetchImplementation;
  }

  async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    if (!url.startsWith("/")) throw new TypeError("GitHub API URL must be repository-relative");
    const target = new URL(url, "https://api.github.com");
    const repositoryPrefix = `/repos/${this.#repository}/`;
    if (
      target.origin !== "https://api.github.com" ||
      target.username !== "" ||
      target.password !== "" ||
      !target.pathname.startsWith(repositoryPrefix)
    ) {
      throw new TypeError("GitHub API URL is outside the bound repository");
    }
    const response = await this.#fetch(target, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init.headers,
      },
    });
    if (!response.ok) throw new TypeError(`GitHub API request failed (${response.status})`);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async bytes(url: string): Promise<Buffer> {
    const target = new URL(url);
    const assetPattern = new RegExp(
      `^/repos/${this.#repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/releases/assets/[1-9]\\d*$`,
      "u",
    );
    if (
      target.origin !== "https://api.github.com" ||
      target.username !== "" ||
      target.password !== "" ||
      !assetPattern.test(target.pathname) ||
      target.search !== "" ||
      target.hash !== ""
    ) {
      throw new TypeError("GitHub asset API URL is outside the bound repository");
    }
    let current = target;
    for (let redirect = 0; redirect <= 5; redirect += 1) {
      const authenticated = current.origin === "https://api.github.com";
      const response = await this.#fetch(current, {
        headers: authenticated
          ? {
              Accept: "application/octet-stream",
              Authorization: `Bearer ${this.#token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            }
          : { Accept: "application/octet-stream" },
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirect === 5) throw new TypeError("GitHub asset redirect is invalid");
        const next = new URL(location, current);
        if (
          next.protocol !== "https:" ||
          next.username !== "" ||
          next.password !== "" ||
          ![
            "release-assets.githubusercontent.com",
            "objects.githubusercontent.com",
            "github-releases.githubusercontent.com",
          ].includes(next.hostname)
        ) {
          throw new TypeError("GitHub asset redirect origin is invalid");
        }
        current = next;
        continue;
      }
      if (!response.ok) throw new TypeError(`GitHub asset download failed (${response.status})`);
      return Buffer.from(await response.arrayBuffer());
    }
    throw new TypeError("GitHub asset redirect bound exceeded");
  }

  async anonymousBytes(url: string): Promise<Buffer> {
    const target = new URL(url);
    const prefix = `/${this.#repository}/releases/`;
    const parts = target.pathname.split("/").map((part) => decodeURIComponent(part));
    const validLatest =
      parts.length === 7 &&
      parts[3] === "releases" &&
      parts[4] === "latest" &&
      parts[5] === "download" &&
      parts[6].length > 0;
    const validTag =
      parts.length === 7 &&
      parts[3] === "releases" &&
      parts[4] === "download" &&
      parts[5].length > 0 &&
      parts[6].length > 0;
    if (
      target.origin !== "https://github.com" ||
      target.username !== "" ||
      target.password !== "" ||
      !target.pathname.startsWith(prefix) ||
      (!validLatest && !validTag) ||
      target.search !== "" ||
      target.hash !== ""
    ) {
      throw new TypeError("anonymous GitHub asset URL is outside the bound repository");
    }
    const response = await this.#fetch(target, {
      headers: { Accept: "application/octet-stream" },
      redirect: "follow",
    });
    if (!response.ok)
      throw new TypeError(`anonymous GitHub asset download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }

  release(id: string | number): Promise<GithubRelease> {
    return this.request(`/repos/${this.#repository}/releases/${id}`);
  }

  async uploadAsset(
    release: Pick<GithubRelease, "id" | "upload_url">,
    name: string,
    bytes: Buffer,
  ): Promise<GithubAsset> {
    const expected = `https://uploads.github.com/repos/${this.#repository}/releases/${release.id}/assets{?name,label}`;
    if (release.upload_url !== expected) throw new TypeError("GitHub upload URL is invalid");
    const target = new URL(expected.slice(0, expected.indexOf("{")));
    target.searchParams.set("name", name);
    const response = await this.#fetch(target, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.#token}`,
        "Content-Type": "application/octet-stream",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
      redirect: "error",
    });
    if (!response.ok) throw new TypeError(`GitHub asset upload failed (${response.status})`);
    return (await response.json()) as GithubAsset;
  }

  deleteAsset(id: number): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("GitHub asset id is invalid");
    return this.request(`/repos/${this.#repository}/releases/assets/${id}`, { method: "DELETE" });
  }

  async latest(): Promise<LatestObservation> {
    const release = await this.latestRelease();
    if (!release) return { id: null, tag: null, metadataSha256: null };
    const metadata = release.assets.find((asset) => asset.name === "latest-mac.yml");
    let metadataSha256: string | null = null;
    if (metadata) {
      const [assetBytes, feedBytes] = await Promise.all([
        this.bytes(metadata.url),
        this.anonymousBytes(`${DESKTOP_FEED_URL}latest-mac.yml`),
      ]);
      if (!assetBytes.equals(feedBytes))
        throw new TypeError("repository latest and updater feed bytes differ");
      metadataSha256 = sha256(feedBytes);
    }
    return { id: release.id, tag: release.tag_name, metadataSha256 };
  }

  async latestRelease(): Promise<GithubRelease | null> {
    const response = await this.#fetch(
      `https://api.github.com/repos/${this.#repository}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new TypeError(`GitHub latest request failed (${response.status})`);
    return (await response.json()) as GithubRelease;
  }

  async releases(): Promise<readonly GithubRelease[]> {
    const releases: GithubRelease[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request<readonly GithubRelease[]>(
        `/repos/${this.#repository}/releases?per_page=100&page=${page}`,
      );
      releases.push(...batch);
      if (batch.length < 100) return releases;
      if (page >= 100)
        throw new TypeError("desktop baseline history exceeds the audited pagination bound");
    }
  }

  async tagCommit(tag: string): Promise<string> {
    let object = (
      await this.request<GithubReference>(
        `/repos/${this.#repository}/git/ref/tags/${encodeURIComponent(tag)}`,
      )
    ).object;
    for (let depth = 0; object.type === "tag" && depth < 8; depth += 1) {
      object = (await this.request<GithubTag>(`/repos/${this.#repository}/git/tags/${object.sha}`))
        .object;
    }
    if (object.type !== "commit" || !commitPattern.test(object.sha)) {
      throw new TypeError("release tag does not resolve to a commit");
    }
    return object.sha;
  }

  repository(): string {
    return this.#repository;
  }
}

function desktopReleaseVersion(release: GithubRelease, excludingTag?: string): string | null {
  if (release.prerelease || release.tag_name === excludingTag) return null;
  const match = /^cycling-coach@(.+)$/u.exec(release.tag_name);
  if (!match || !versionPattern.test(match[1])) return null;
  const expected = [...releaseFileNames(match[1])].sort();
  const actual = release.assets.map((asset) => asset.name).sort();
  return actual.length === expected.length &&
    actual.every((name, index) => name === expected[index])
    ? match[1]
    : null;
}

async function newestDesktopRelease(
  releases: readonly GithubRelease[],
  client: GithubClient,
  excludingTag?: string,
): Promise<{ release: GithubRelease; version: string; commit: string } | null> {
  let selected: { release: GithubRelease; version: string; commit: string } | null = null;
  for (const release of releases) {
    const version = desktopReleaseVersion(release, excludingTag);
    if (!version) continue;
    const commit = await client.tagCommit(release.tag_name);
    if (!selected || compareVersions(version, selected.version) > 0) {
      selected = { release, version, commit };
    }
  }
  return selected;
}

async function exactDesktopRelease(
  release: GithubRelease | undefined | null,
  client: GithubClient,
  tag: string,
): Promise<{ release: GithubRelease; version: string; commit: string } | null> {
  if (!release || release.tag_name !== tag) return null;
  const version = desktopReleaseVersion(release);
  if (!version) return null;
  return { release, version, commit: await client.tagCommit(tag) };
}

async function steadyDesktopBaseline(
  releases: readonly GithubRelease[],
  client: GithubClient,
  requestedTag: string,
): Promise<Awaited<ReturnType<typeof newestDesktopRelease>>> {
  const latest = await client.latestRelease();
  const accepted = latest ? await exactDesktopRelease(latest, client, latest.tag_name) : null;
  if (accepted) {
    if (requestedTag !== "none" && requestedTag !== accepted.release.tag_name) {
      throw new TypeError("steady baseline must match the accepted desktop latest release");
    }
    return accepted;
  }
  if (requestedTag === "none") return null;
  return exactDesktopRelease(
    releases.find((release) => release.tag_name === requestedTag),
    client,
    requestedTag,
  );
}

async function resolvedBaselineForManifest(
  manifest: DesktopReleaseManifest,
  client: GithubClient,
): Promise<Awaited<ReturnType<typeof newestDesktopRelease>>> {
  const releases = await client.releases();
  if (manifest.mode === "genesis") return newestDesktopRelease(releases, client, manifest.tag);
  return steadyDesktopBaseline(releases, client, manifest.baselineTag);
}

async function verifyReleaseBinding(
  client: GithubClient,
  manifest: DesktopReleaseManifest,
): Promise<GithubRelease> {
  const release = await client.release(manifest.draftId);
  if (
    String(release.id) !== manifest.draftId ||
    !release.draft ||
    release.prerelease ||
    release.tag_name !== manifest.tag
  )
    throw new TypeError("GitHub draft binding mismatch");
  if (sha256(Buffer.from(release.body, "utf8")) !== manifest.draftBodySha256)
    throw new TypeError("GitHub draft body binding mismatch");
  if ((await client.tagCommit(manifest.tag)) !== manifest.commit)
    throw new TypeError("Git tag commit binding mismatch");
  return release;
}

async function preflightReleaseAssets(
  client: GithubClient,
  release: GithubRelease,
  manifest: DesktopReleaseManifest,
): Promise<readonly GithubAsset[]> {
  const starters: GithubAsset[] = [];
  for (const file of manifest.files) {
    const asset = release.assets.find((candidate) => candidate.name === file.name);
    if (!asset) continue;
    if (asset.state === "starter") {
      if (!release.draft) throw new TypeError(`starter asset exists outside a draft: ${file.name}`);
      starters.push(asset);
      continue;
    }
    if (asset.state !== "uploaded")
      throw new TypeError(`release asset state is invalid: ${file.name}`);
    const remote = await client.bytes(asset.url);
    assertRemoteAsset(file, remote);
  }
  return starters;
}

async function uploadWithRecovery(
  client: GithubClient,
  release: GithubRelease,
  directory: string,
  manifest: DesktopReleaseManifest,
  file: DesktopReleaseFile,
): Promise<void> {
  const local = await stableFile(resolve(directory, file.name));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const uploaded = await client.uploadAsset(release, file.name, local.bytes);
      if (uploaded.state !== "uploaded")
        throw new TypeError(`uploaded release asset state is invalid: ${file.name}`);
      assertRemoteAsset(file, await client.bytes(uploaded.url));
      return;
    } catch (error) {
      const current = await client.release(release.id);
      if (!current.draft || current.prerelease || current.tag_name !== release.tag_name)
        throw error;
      assertPublishableAssets(current.assets, manifest);
      const observed = current.assets.find((candidate) => candidate.name === file.name);
      if (observed?.state === "uploaded") {
        assertRemoteAsset(file, await client.bytes(observed.url));
        return;
      }
      if (observed?.state === "starter") await client.deleteAsset(observed.id);
      else if (observed) throw error;
      if (attempt === 3) throw error;
    }
  }
}

async function stageExactAssets(
  client: GithubClient,
  release: GithubRelease,
  directory: string,
  manifest: DesktopReleaseManifest,
): Promise<GithubRelease> {
  const starters = await preflightReleaseAssets(client, release, manifest);
  for (const starter of starters) await client.deleteAsset(starter.id);
  const starterNames = new Set(starters.map((asset) => asset.name));
  for (const file of manifest.files) {
    const existing = release.assets.find((asset) => asset.name === file.name);
    if (!existing || starterNames.has(file.name))
      await uploadWithRecovery(client, release, directory, manifest, file);
  }
  const staged = await verifyReleaseBinding(client, manifest);
  assertPublishableAssets(staged.assets, manifest);
  if (staged.assets.length !== manifest.files.length)
    throw new TypeError("staged release asset set is incomplete");
  for (const file of manifest.files) {
    const asset = staged.assets.find((candidate) => candidate.name === file.name);
    if (!asset || asset.state !== "uploaded")
      throw new TypeError(`staged release asset is incomplete: ${file.name}`);
    assertRemoteAsset(file, await client.bytes(asset.url));
  }
  return staged;
}

export async function publishDesktopRelease(
  directory: string,
  client: GithubClient,
): Promise<LatestObservation> {
  const manifest = await verifyDesktopRelease(directory);
  if (manifest.mode !== "steady")
    throw new TypeError("genesis desktop release must remain a private draft");
  const release = await verifyReleaseBinding(client, manifest);
  assertPublishableAssets(release.assets, manifest);
  const baseline = await resolvedBaselineForManifest(manifest, client);
  await assertResolvedBaseline(manifest, baseline, client);
  const observedLatest = await client.latest();
  await stageExactAssets(client, release, directory, manifest);
  await client.request(`/repos/${client.repository()}/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft: false, make_latest: "false" }),
  });
  const published = await client.release(release.id);
  if (published.draft) throw new TypeError("desktop release remained a draft");
  for (const file of manifest.files) {
    const asset = published.assets.find((candidate) => candidate.name === file.name);
    if (!asset) throw new TypeError(`published release asset is missing: ${file.name}`);
    const url = new URL(asset.browser_download_url);
    const parts = url.pathname.split("/").map((part) => decodeURIComponent(part));
    if (!parts.includes(manifest.tag) || parts.at(-1) !== file.name) {
      throw new TypeError(`release asset is not tag-specific: ${file.name}`);
    }
    const remote = await client.anonymousBytes(asset.browser_download_url);
    if (remote.length !== file.size || sha256(remote) !== file.sha256) {
      throw new TypeError(`tag-specific release download mismatch: ${file.name}`);
    }
  }
  return observedLatest;
}

export async function stageDesktopRelease(directory: string, client: GithubClient): Promise<void> {
  const manifest = await verifyDesktopRelease(directory);
  const release = await verifyReleaseBinding(client, manifest);
  assertPublishableAssets(release.assets, manifest);
  const baseline = await resolvedBaselineForManifest(manifest, client);
  await assertResolvedBaseline(manifest, baseline, client);
  await stageExactAssets(client, release, directory, manifest);
}

export async function promoteDesktopLatest(
  directory: string,
  client: GithubClient,
  observed: LatestObservation,
): Promise<void> {
  const manifest = await verifyDesktopRelease(directory);
  const candidate = await client.release(manifest.draftId);
  if (candidate.draft || candidate.prerelease || candidate.tag_name !== manifest.tag)
    throw new TypeError("published candidate binding mismatch");
  if (sha256(Buffer.from(candidate.body, "utf8")) !== manifest.draftBodySha256)
    throw new TypeError("published release body binding mismatch");
  if ((await client.tagCommit(manifest.tag)) !== manifest.commit)
    throw new TypeError("published tag commit binding mismatch");
  const current = await client.latest();
  const previous = await newestDesktopRelease(await client.releases(), client, manifest.tag);
  assertLatestCas(manifest.version, observed, current, previous?.version ?? null);
  for (const file of manifest.files) {
    const asset = candidate.assets.find((candidateAsset) => candidateAsset.name === file.name);
    if (!asset || asset.state !== "uploaded")
      throw new TypeError(`promotion candidate asset is missing: ${file.name}`);
    const remote = await client.anonymousBytes(asset.browser_download_url);
    assertRemoteAsset(file, remote);
  }
  assertLatestCas(manifest.version, observed, await client.latest(), previous?.version ?? null);
  await client.request(`/repos/${client.repository()}/releases/${candidate.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ make_latest: "true" }),
  });
  const promoted = await client.latest();
  if (promoted.id !== candidate.id || promoted.tag !== manifest.tag) {
    throw new TypeError("desktop latest promotion did not round-trip");
  }
}

export async function prepareDesktopBaseline(
  directory: string,
  client: GithubClient,
  mode: DesktopReleaseMode,
  candidateVersion: string,
  requestedBaselineTag: string,
  output: string,
): Promise<void> {
  const version = requireVersion(candidateVersion);
  const releases = await client.releases();
  if (mode === "genesis") {
    const baseline = await newestDesktopRelease(releases, client, `cycling-coach@${version}`);
    if (baseline !== null)
      throw new TypeError("genesis release refused after a desktop baseline exists");
    await writeFile(
      output,
      "baseline_tag=none\nbaseline_release_id=none\nbaseline_commit=none\nbaseline_zip_sha256=none\nbaseline_signing_identity=none\nbaseline_cdhash=none\nbaseline_zip=none\n",
      { flag: "a" },
    );
    return;
  }
  const baseline = await steadyDesktopBaseline(releases, client, requestedBaselineTag);
  if (baseline === null) throw new TypeError("steady release requires a desktop baseline");
  if (compareVersions(baseline.version, version) >= 0)
    throw new TypeError("steady desktop baseline must precede the candidate version");
  const zipName = releaseFileNames(baseline.version)[1];
  const asset = baseline.release.assets.find((candidate) => candidate.name === zipName);
  if (!asset) throw new TypeError("desktop baseline ZIP is missing");
  const bytes = await client.bytes(asset.url);
  if (bytes.length !== asset.size || bytes.length === 0)
    throw new TypeError("desktop baseline ZIP is invalid");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, zipName);
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  await writeFile(
    output,
    `baseline_tag=${baseline.release.tag_name}\nbaseline_release_id=${baseline.release.id}\nbaseline_commit=${baseline.commit}\nbaseline_zip_sha256=${sha256(bytes)}\nbaseline_zip=${path}\n`,
    { flag: "a" },
  );
}

function argument(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`missing --${name}`);
  return value;
}

function bindingArguments(): Parameters<typeof requireBinding>[0] {
  return {
    tag: argument("tag"),
    version: argument("version"),
    commit: argument("commit"),
    draftId: argument("draft-id"),
    mode: argument("mode"),
    workflowRunId: argument("workflow-run-id"),
    workflowRunAttempt: argument("workflow-run-attempt"),
    draftBodySha256: argument("draft-body-sha256"),
    npmIntegrity: argument("npm-integrity"),
    npmAttestationUrl: argument("npm-attestation-url"),
    signingIdentity: argument("signing-identity"),
    candidateCdHash: argument("candidate-cdhash"),
    candidateCodeDirectorySha256: argument("candidate-code-directory-sha256"),
    baselineTag: argument("baseline-tag"),
    baselineReleaseId: argument("baseline-release-id"),
    baselineCommit: argument("baseline-commit"),
    baselineZipSha256: argument("baseline-zip-sha256"),
    baselineSigningIdentity: argument("baseline-signing-identity"),
    baselineCdHash: argument("baseline-cdhash"),
  };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "verify-npm-provenance") {
    const metadata = JSON.parse(await readFile(resolve(argument("metadata")), "utf8")) as unknown;
    const { verify: verifySigstore } = await import("sigstore");
    await verifyNpmProvenanceBundle(
      metadata,
      {
        name: argument("name"),
        version: requireVersion(argument("version")),
        integrity: argument("integrity"),
        repository: argument("repository"),
        workflow: argument("workflow"),
        ref: argument("ref"),
        commit: argument("commit"),
        invocationId: argument("invocation-id"),
        allowPriorInvocation: argument("allow-prior-invocation") === "true",
        releaseTag: argument("release-tag"),
        eventName: argument("event-name"),
        repositoryId: argument("repository-id"),
        repositoryOwnerId: argument("repository-owner-id"),
      },
      async (bundle, identity) => {
        const escapedIdentity = identity.uri.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        await verifySigstore(bundle as Parameters<typeof verifySigstore>[0], {
          certificateIssuer: identity.issuer,
          certificateIdentityURI: `^${escapedIdentity}$`,
        });
      },
    );
    return;
  }
  const directory = resolve(argument("directory"));
  if (command === "seal") {
    await sealDesktopRelease(directory, bindingArguments());
    return;
  }
  if (command === "verify") {
    await verifyDesktopRelease(directory, bindingArguments());
    return;
  }
  if (command === "public-envelope") {
    await materializeDesktopPublicEnvelope(directory, resolve(argument("output")));
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.GITHUB_TOKEN ?? "";
  const client = new GithubClient(repository, token);
  if (command === "baseline") {
    await prepareDesktopBaseline(
      directory,
      client,
      requireMode(argument("mode")),
      requireVersion(argument("candidate-version")),
      argument("baseline-tag"),
      argument("github-output"),
    );
    return;
  }
  if (command === "publish") {
    const observed = await publishDesktopRelease(directory, client);
    const output = argument("github-output");
    await writeFile(
      output,
      `latest_id=${observed.id ?? "none"}\nlatest_tag=${observed.tag ?? "none"}\nlatest_metadata_sha256=${observed.metadataSha256 ?? "none"}\n`,
      { flag: "a" },
    );
    return;
  }
  if (command === "stage") {
    await stageDesktopRelease(directory, client);
    return;
  }
  if (command === "promote") {
    const id = argument("expected-latest-id");
    const tag = argument("expected-latest-tag");
    const expectedMetadataSha256 = argument("expected-latest-metadata-sha256");
    if (id !== "none" && !/^[1-9]\d*$/u.test(id))
      throw new TypeError("expected latest id is invalid");
    if (expectedMetadataSha256 !== "none" && !/^[0-9a-f]{64}$/u.test(expectedMetadataSha256))
      throw new TypeError("expected latest metadata hash is invalid");
    await promoteDesktopLatest(directory, client, {
      id: id === "none" ? null : Number(id),
      tag: tag === "none" ? null : tag,
      metadataSha256: expectedMetadataSha256 === "none" ? null : expectedMetadataSha256,
    });
    return;
  }
  throw new TypeError(
    "desktop release command must be verify-npm-provenance, seal, verify, public-envelope, baseline, stage, publish, or promote",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "desktop release transaction failed"}\n`,
    );
    process.exitCode = 1;
  });
}
