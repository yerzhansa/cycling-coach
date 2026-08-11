import { lstatSync, realpathSync, type Stats } from "node:fs";
import { dirname } from "node:path";
import {
  classifyPrivatePathDurability,
  classifyPrivatePathErrorCode,
  decidePrivatePathBinding,
  decidePrivatePathEntry,
  decidePrivatePathRead,
  type PrivatePathBindingDecisionInput,
  type PrivatePathDurabilityClassification,
  type PrivatePathDurabilityStage,
  type PrivatePathEntryDecisionInput,
  type PrivatePathPolicyDecision,
  type PrivatePathPolicyErrorCategory,
  type PrivatePathReadDecisionInput,
} from "@enduragent/kernel/ports";

export type WindowsPrivatePathPolicyStage =
  | Exclude<PrivatePathDurabilityStage, "directory-sync">
  | "binding-check"
  | "entry-check"
  | "read-check";

export interface WindowsPrivatePathIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

export interface WindowsPrivateDirectoryBinding {
  readonly path: string;
  readonly parentPath: string;
  readonly identity: WindowsPrivatePathIdentity;
  readonly parentIdentity: WindowsPrivatePathIdentity;
}

export class WindowsPrivatePathPolicyError extends Error {
  override readonly name = "WindowsPrivatePathPolicyError";
  readonly stage: WindowsPrivatePathPolicyStage;
  readonly category: PrivatePathPolicyErrorCategory;

  constructor(stage: WindowsPrivatePathPolicyStage, category: PrivatePathPolicyErrorCategory) {
    super("Windows private path policy failed");
    this.stage = stage;
    this.category = category;
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function assertDecision(
  stage: WindowsPrivatePathPolicyStage,
  decision: PrivatePathPolicyDecision,
): void {
  if (decision.kind === "reject") {
    throw new WindowsPrivatePathPolicyError(stage, decision.category);
  }
}

export function classifyWindowsPrivatePathDurability(
  stage: PrivatePathDurabilityStage,
): PrivatePathDurabilityClassification {
  return classifyPrivatePathDurability({ platform: "windows", stage });
}

export function classifyWindowsPrivatePathFailure(
  stage: WindowsPrivatePathPolicyStage,
  error: unknown,
): WindowsPrivatePathPolicyError {
  if (error instanceof WindowsPrivatePathPolicyError) return error;
  return new WindowsPrivatePathPolicyError(stage, classifyPrivatePathErrorCode(errorCode(error)));
}

export function assertWindowsPrivatePathEntry(input: PrivatePathEntryDecisionInput): void {
  assertDecision("entry-check", decidePrivatePathEntry(input));
}

export function assertWindowsPrivatePathBinding(input: PrivatePathBindingDecisionInput): void {
  assertDecision("binding-check", decidePrivatePathBinding(input));
}

export function assertWindowsPrivatePathRead(input: PrivatePathReadDecisionInput): void {
  assertDecision("read-check", decidePrivatePathRead(input));
}

export function windowsPrivatePathIdentity(metadata: Stats): WindowsPrivatePathIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

export function sameWindowsPrivatePathIdentity(
  left: WindowsPrivatePathIdentity,
  right: WindowsPrivatePathIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function entryType(metadata: Stats): PrivatePathEntryDecisionInput["actualType"] {
  if (metadata.isFile()) return "file";
  if (metadata.isDirectory()) return "directory";
  return "other";
}

function assertDirectoryEntry(metadata: Stats): void {
  assertWindowsPrivatePathEntry({
    expectedType: "directory",
    actualType: entryType(metadata),
    linkOrReparseShaped: metadata.isSymbolicLink(),
  });
}

export function assertWindowsPrivateFileMetadata(metadata: Stats, allowedLinks: 1 | 2 = 1): void {
  assertWindowsPrivatePathEntry({
    expectedType: "file",
    actualType: entryType(metadata),
    linkOrReparseShaped: metadata.isSymbolicLink(),
  });
  assertWindowsPrivatePathBinding({
    identityStable: true,
    authenticatedHomeBinding: metadata.nlink === allowedLinks,
  });
}

function observeDirectoryBinding(parentPath: string, path: string): WindowsPrivateDirectoryBinding {
  const parentBefore = lstatSync(parentPath);
  const parentPhysicalPath = realpathSync(parentPath);
  const parentPhysical = lstatSync(parentPhysicalPath);
  const parentAfter = lstatSync(parentPath);
  const before = lstatSync(path);
  const physicalPath = realpathSync(path);
  const physical = lstatSync(physicalPath);
  const after = lstatSync(path);
  const physicalParent = lstatSync(dirname(physicalPath));
  for (const metadata of [parentBefore, parentPhysical, parentAfter, before, physical, after]) {
    assertDirectoryEntry(metadata);
  }
  assertDirectoryEntry(physicalParent);
  const parentIdentity = windowsPrivatePathIdentity(parentBefore);
  const pathIdentity = windowsPrivatePathIdentity(before);
  assertWindowsPrivatePathBinding({
    identityStable:
      sameWindowsPrivatePathIdentity(parentIdentity, windowsPrivatePathIdentity(parentPhysical)) &&
      sameWindowsPrivatePathIdentity(parentIdentity, windowsPrivatePathIdentity(parentAfter)) &&
      sameWindowsPrivatePathIdentity(pathIdentity, windowsPrivatePathIdentity(physical)) &&
      sameWindowsPrivatePathIdentity(pathIdentity, windowsPrivatePathIdentity(after)),
    authenticatedHomeBinding: sameWindowsPrivatePathIdentity(
      parentIdentity,
      windowsPrivatePathIdentity(physicalParent),
    ),
  });
  return { path, parentPath, identity: pathIdentity, parentIdentity };
}

export function bindWindowsPrivateDirectory(
  parentPath: string,
  path: string,
): WindowsPrivateDirectoryBinding {
  try {
    return observeDirectoryBinding(parentPath, path);
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("binding-check", error);
  }
}

export function assertWindowsPrivateDirectoryStable(binding: WindowsPrivateDirectoryBinding): void {
  try {
    const observed = observeDirectoryBinding(binding.parentPath, binding.path);
    assertWindowsPrivatePathBinding({
      identityStable:
        sameWindowsPrivatePathIdentity(binding.identity, observed.identity) &&
        sameWindowsPrivatePathIdentity(binding.parentIdentity, observed.parentIdentity),
      authenticatedHomeBinding: true,
    });
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("binding-check", error);
  }
}

export function assertWindowsPrivateFileBinding(
  directory: WindowsPrivateDirectoryBinding,
  path: string,
  expectedIdentity: WindowsPrivatePathIdentity,
  allowedLinks: 1 | 2 = 1,
): Stats {
  try {
    assertWindowsPrivateDirectoryStable(directory);
    const before = lstatSync(path);
    const physicalPath = realpathSync(path);
    const physical = lstatSync(physicalPath);
    const after = lstatSync(path);
    const physicalParent = lstatSync(dirname(physicalPath));
    assertWindowsPrivateFileMetadata(before, allowedLinks);
    assertWindowsPrivateFileMetadata(physical, allowedLinks);
    assertWindowsPrivateFileMetadata(after, allowedLinks);
    assertDirectoryEntry(physicalParent);
    assertWindowsPrivatePathBinding({
      identityStable:
        sameWindowsPrivatePathIdentity(expectedIdentity, windowsPrivatePathIdentity(before)) &&
        sameWindowsPrivatePathIdentity(expectedIdentity, windowsPrivatePathIdentity(physical)) &&
        sameWindowsPrivatePathIdentity(expectedIdentity, windowsPrivatePathIdentity(after)),
      authenticatedHomeBinding: sameWindowsPrivatePathIdentity(
        directory.identity,
        windowsPrivatePathIdentity(physicalParent),
      ),
    });
    assertWindowsPrivateDirectoryStable(directory);
    return after;
  } catch (error) {
    throw classifyWindowsPrivatePathFailure("binding-check", error);
  }
}
