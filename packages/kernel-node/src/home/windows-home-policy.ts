import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import {
  classifyPrivatePathErrorCode,
  decidePrivatePathBinding,
  decidePrivatePathEntry,
  decidePrivatePathRoot,
  type PrivatePathEntryType,
  type PrivatePathPolicyDecision,
  type PrivatePathPolicyErrorCategory,
} from "@enduragent/kernel/ports";
import type { AthleteHome } from "./resolve-athlete-home.js";

type PathMetadata = Awaited<ReturnType<typeof lstat>>;

interface PathIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

interface DirectoryBinding {
  readonly path: string;
  readonly identity: PathIdentity;
}

export type WindowsAthleteHomePolicyStage =
  | "layout"
  | "root-create"
  | "root-entry"
  | "root-bind"
  | "child-create"
  | "child-entry"
  | "child-bind"
  | "directory-create"
  | "directory-entry"
  | "directory-bind";

export class WindowsAthleteHomePolicyError extends Error {
  override readonly name = "WindowsAthleteHomePolicyError";
  readonly stage: WindowsAthleteHomePolicyStage;
  readonly category: PrivatePathPolicyErrorCategory;

  constructor(stage: WindowsAthleteHomePolicyStage, category: PrivatePathPolicyErrorCategory) {
    super("Windows athlete home policy failed");
    this.stage = stage;
    this.category = category;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function policyFailure(
  stage: WindowsAthleteHomePolicyStage,
  error: unknown,
): WindowsAthleteHomePolicyError {
  if (error instanceof WindowsAthleteHomePolicyError) return error;
  return new WindowsAthleteHomePolicyError(stage, classifyPrivatePathErrorCode(errorCode(error)));
}

function assertDecision(
  stage: WindowsAthleteHomePolicyStage,
  decision: PrivatePathPolicyDecision,
): void {
  if (decision.kind === "reject") {
    throw new WindowsAthleteHomePolicyError(stage, decision.category);
  }
}

function entryType(metadata: PathMetadata): PrivatePathEntryType {
  if (metadata.isFile()) return "file";
  if (metadata.isDirectory()) return "directory";
  return "other";
}

function pathIdentity(metadata: PathMetadata): PathIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertDirectoryEntry(stage: WindowsAthleteHomePolicyStage, metadata: PathMetadata): void {
  assertDecision(
    stage,
    decidePrivatePathEntry({
      expectedType: "directory",
      actualType: entryType(metadata),
      linkOrReparseShaped: metadata.isSymbolicLink(),
    }),
  );
}

async function optionalEntry(
  path: string,
  stage: WindowsAthleteHomePolicyStage,
): Promise<PathMetadata | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw policyFailure(stage, error);
  }
}

async function requiredEntry(
  path: string,
  stage: WindowsAthleteHomePolicyStage,
): Promise<PathMetadata> {
  try {
    return await lstat(path);
  } catch (error) {
    throw policyFailure(stage, error);
  }
}

async function ensureDirectory(
  path: string,
  recursive: boolean,
  createStage: WindowsAthleteHomePolicyStage,
  entryStage: WindowsAthleteHomePolicyStage,
): Promise<PathMetadata> {
  let metadata = await optionalEntry(path, entryStage);
  if (metadata === undefined) {
    try {
      await mkdir(path, { recursive });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw policyFailure(createStage, error);
    }
    metadata = await requiredEntry(path, entryStage);
  }
  assertDirectoryEntry(entryStage, metadata);
  return metadata;
}

async function observeDirectoryBinding(
  path: string,
  before: PathMetadata,
  entryStage: WindowsAthleteHomePolicyStage,
  bindStage: WindowsAthleteHomePolicyStage,
): Promise<{
  readonly physicalPath: string;
  readonly identityStable: boolean;
  readonly authenticatedBinding: boolean;
}> {
  let physicalPath: string;
  try {
    physicalPath = await realpath(path);
  } catch (error) {
    throw policyFailure(bindStage, error);
  }
  const physical = await requiredEntry(physicalPath, entryStage);
  const after = await requiredEntry(path, entryStage);
  assertDirectoryEntry(entryStage, physical);
  assertDirectoryEntry(entryStage, after);
  const beforeIdentity = pathIdentity(before);
  return {
    physicalPath,
    identityStable: sameIdentity(beforeIdentity, pathIdentity(after)),
    authenticatedBinding: sameIdentity(beforeIdentity, pathIdentity(physical)),
  };
}

function validateLayout(home: AthleteHome): void {
  if (!isAbsolute(home.root)) {
    throw new WindowsAthleteHomePolicyError("layout", "corruption");
  }
  const root = resolve(home.root);
  for (const [name, path] of [
    ["store", home.storeDir],
    ["archive", home.archiveDir],
    ["config", home.configDir],
  ] as const) {
    if (resolve(path) !== join(root, name)) {
      throw new WindowsAthleteHomePolicyError("layout", "corruption");
    }
  }
}

async function prepareRoot(path: string): Promise<DirectoryBinding> {
  const before = await ensureDirectory(path, true, "root-create", "root-entry");
  const observed = await observeDirectoryBinding(path, before, "root-entry", "root-bind");
  assertDecision(
    "root-bind",
    decidePrivatePathRoot({
      ordinary: observed.physicalPath !== parse(observed.physicalPath).root,
      identityStable: observed.identityStable,
      authenticatedHomeBinding: observed.authenticatedBinding,
    }),
  );
  return { path: observed.physicalPath, identity: pathIdentity(before) };
}

async function prepareChild(path: string, parent: DirectoryBinding): Promise<void> {
  const before = await ensureDirectory(path, false, "child-create", "child-entry");
  const observed = await observeDirectoryBinding(path, before, "child-entry", "child-bind");
  const currentParent = await requiredEntry(parent.path, "child-bind");
  const physicalParent = await requiredEntry(dirname(observed.physicalPath), "child-bind");
  assertDirectoryEntry("child-entry", currentParent);
  assertDirectoryEntry("child-entry", physicalParent);
  assertDecision(
    "child-bind",
    decidePrivatePathBinding({
      identityStable: observed.identityStable,
      authenticatedHomeBinding:
        observed.authenticatedBinding &&
        sameIdentity(parent.identity, pathIdentity(currentParent)) &&
        sameIdentity(parent.identity, pathIdentity(physicalParent)),
    }),
  );
}

export async function ensureWindowsPrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new WindowsAthleteHomePolicyError("directory-bind", "corruption");
  }
  const before = await ensureDirectory(path, true, "directory-create", "directory-entry");
  const observed = await observeDirectoryBinding(path, before, "directory-entry", "directory-bind");
  assertDecision(
    "directory-bind",
    decidePrivatePathRoot({
      ordinary: observed.physicalPath !== parse(observed.physicalPath).root,
      identityStable: observed.identityStable,
      authenticatedHomeBinding: observed.authenticatedBinding,
    }),
  );
  return observed.physicalPath;
}

export async function prepareWindowsAthleteHome(home: AthleteHome): Promise<AthleteHome> {
  validateLayout(home);
  const root = await prepareRoot(home.root);
  const prepared = {
    root: root.path,
    storeDir: join(root.path, "store"),
    archiveDir: join(root.path, "archive"),
    configDir: join(root.path, "config"),
  } satisfies AthleteHome;

  for (const path of [prepared.storeDir, prepared.archiveDir, prepared.configDir]) {
    await prepareChild(path, root);
  }

  const finalRoot = await requiredEntry(root.path, "root-bind");
  assertDirectoryEntry("root-entry", finalRoot);
  assertDecision(
    "root-bind",
    decidePrivatePathBinding({
      identityStable: sameIdentity(root.identity, pathIdentity(finalRoot)),
      authenticatedHomeBinding: true,
    }),
  );
  return Object.freeze(prepared);
}
