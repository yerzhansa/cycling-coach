import { randomBytes } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";

import {
  ClaudeWorkingAreaError,
  type ClaudeWorkingAreaFailureCategory,
  type ClaudeWorkingAreaStage,
} from "./errors.js";
import { readEnvironmentValue, resolveClaudeConfigDir } from "./env.js";

export type ClaudeLaunchPurpose =
  | "version"
  | "account"
  | "account-recheck"
  | "generation"
  | "resume"
  | "retry"
  | "rebuild"
  | "maintenance";

export interface ClaudeWorkingAreaBinding {
  readonly cwd: string;
  assertCurrent(): void;
}

export interface ClaudeWorkingAreaPort {
  readonly cacheKey: string;
  prepareForLaunch(purpose: ClaudeLaunchPurpose): Promise<ClaudeWorkingAreaBinding>;
}

interface PathIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

export interface ClaudeWorkingAreaFileSystem {
  readonly accessSync: typeof accessSync;
  readonly closeSync: typeof closeSync;
  readonly fstatSync: typeof fstatSync;
  readonly lstatSync: typeof lstatSync;
  readonly mkdirSync: typeof mkdirSync;
  readonly openSync: typeof openSync;
  readonly readSync: typeof readSync;
  readonly readdirSync: typeof readdirSync;
  readonly realpathSync: typeof realpathSync;
  readonly renameSync: typeof renameSync;
  readonly unlinkSync: typeof unlinkSync;
  readonly writeFileSync: typeof writeFileSync;
}

export interface CreateClaudeWorkingAreaInput {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly forbiddenRoots?: readonly string[];
  readonly configDir?: string;
  readonly fileSystem?: Partial<ClaudeWorkingAreaFileSystem>;
}

const nodeFileSystem: ClaudeWorkingAreaFileSystem = {
  accessSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
};

const OWNERSHIP_MARKER_NAME = ".enduragent-ownership";
const OWNERSHIP_TOKEN_BYTES = 32;
const OWNERSHIP_TOKEN_LENGTH = OWNERSHIP_TOKEN_BYTES * 2;
const OWNERSHIP_PUBLICATION_ATTEMPT_COUNT = 2;
const OWNERSHIP_PUBLICATION_RETRY_COUNT = 20;
const OWNERSHIP_PUBLICATION_RETRY_DELAY_MS = 5;
const ownershipPublicationWait = new Int32Array(new SharedArrayBuffer(4));

function failure(
  stage: ClaudeWorkingAreaStage,
  category: ClaudeWorkingAreaFailureCategory,
): ClaudeWorkingAreaError {
  return new ClaudeWorkingAreaError(stage, category);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function identity(metadata: Stats): PathIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathEquals(left: string, right: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function containsPath(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === "win32" ? win32 : { isAbsolute, resolve, relative, sep };
  const normalizedParent = pathApi.resolve(parent);
  const normalizedChild = pathApi.resolve(child);
  const delta = pathApi.relative(normalizedParent, normalizedChild);
  return delta === "" || (!delta.startsWith("..") && !pathApi.isAbsolute(delta));
}

function pathsOverlap(left: string, right: string, platform: NodeJS.Platform): boolean {
  return containsPath(left, right, platform) || containsPath(right, left, platform);
}

function resolveHome(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  explicit: string | undefined,
): string {
  const raw =
    explicit ??
    (platform === "win32"
      ? readEnvironmentValue(environment, "USERPROFILE", platform)
      : environment.HOME) ??
    homedir();
  const pathApi = platform === "win32" ? win32 : { isAbsolute, resolve };
  if (!pathApi.isAbsolute(raw)) throw failure("resolve", "root");
  return pathApi.resolve(raw);
}

export function resolveClaudeWorkingAreaPath(
  input: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
    readonly homeDirectory?: string;
  } = {},
): {
  readonly cacheRoot: string;
  readonly appRoot: string;
  readonly workspace: string;
  readonly home: string;
} {
  const platform = input.platform ?? process.platform;
  const environment = input.environment ?? process.env;
  const home = resolveHome(platform, environment, input.homeDirectory);
  if (platform === "win32") {
    const rawCacheRoot =
      readEnvironmentValue(environment, "LOCALAPPDATA", platform) ??
      win32.join(home, "AppData", "Local");
    if (!win32.isAbsolute(rawCacheRoot)) throw failure("resolve", "root");
    const cacheRoot = assertUsableCacheRoot(rawCacheRoot, platform);
    const appRoot = win32.resolve(cacheRoot, "Enduragent Claude");
    return { cacheRoot, appRoot, workspace: win32.join(appRoot, "workspace"), home };
  }
  if (platform === "darwin") {
    const cacheRoot = assertUsableCacheRoot(join(home, "Library", "Caches"), platform);
    const appRoot = join(cacheRoot, "Enduragent", "claude");
    return { cacheRoot, appRoot, workspace: join(appRoot, "workspace"), home };
  }
  const configuredCacheRoot = environment.XDG_CACHE_HOME;
  const rawCacheRoot =
    configuredCacheRoot === undefined || configuredCacheRoot === ""
      ? join(home, ".cache")
      : configuredCacheRoot;
  if (!isAbsolute(rawCacheRoot)) throw failure("resolve", "root");
  const cacheRoot = assertUsableCacheRoot(rawCacheRoot, platform);
  const appRoot = resolve(cacheRoot, "enduragent", "claude");
  return { cacheRoot, appRoot, workspace: join(appRoot, "workspace"), home };
}

function assertUsableCacheRoot(cacheRoot: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    const normalized = win32.resolve(cacheRoot);
    if (win32.normalize(cacheRoot).startsWith("\\\\")) throw failure("resolve", "root");
    if (pathEquals(normalized, win32.parse(normalized).root, platform)) {
      throw failure("resolve", "root");
    }
    return normalized;
  }
  const normalized = resolve(cacheRoot);
  if (pathEquals(normalized, parse(normalized).root, platform)) throw failure("resolve", "root");
  return normalized;
}

function existingMetadata(
  path: string,
  fileSystem: ClaudeWorkingAreaFileSystem,
): Stats | undefined {
  try {
    return fileSystem.lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw failure("entry-check", "io-failure");
  }
}

function assertDirectory(metadata: Stats): void {
  if (metadata.isSymbolicLink()) throw failure("entry-check", "link-reparse");
  if (!metadata.isDirectory()) throw failure("entry-check", "entry-type");
}

function assertRegularSingleLinkFile(metadata: Stats): void {
  if (metadata.isSymbolicLink()) throw failure("entry-check", "link-reparse");
  if (!metadata.isFile()) throw failure("entry-check", "entry-type");
  if (metadata.nlink !== 1) throw failure("entry-check", "link-reparse");
}

function assertPosixPrivate(metadata: Stats): void {
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw failure("permission-check", "owner");
  }
  if ((metadata.mode & 0o077) !== 0) throw failure("permission-check", "permissions");
}

function assertAccess(path: string, fileSystem: ClaudeWorkingAreaFileSystem): void {
  try {
    fileSystem.accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw failure("permission-check", "unavailable");
  }
}

function assertFileAccess(path: string, fileSystem: ClaudeWorkingAreaFileSystem): void {
  try {
    fileSystem.accessSync(path, constants.R_OK | constants.W_OK);
  } catch {
    throw failure("permission-check", "unavailable");
  }
}

function assertCanonical(
  path: string,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): string {
  let physical: string;
  try {
    physical = fileSystem.realpathSync(path);
  } catch {
    throw failure("binding-check", "io-failure");
  }
  if (!pathEquals(path, physical, platform)) throw failure("binding-check", "link-reparse");
  return physical;
}

function hasRepositoryAncestor(
  path: string,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): boolean {
  const pathApi = platform === "win32" ? win32 : { dirname, join };
  let current = path;
  for (;;) {
    if (existingMetadata(pathApi.join(current, ".git"), fileSystem) !== undefined) return true;
    const parent = pathApi.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function defaultForbiddenRoots(
  home: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { readonly lexical: string[]; readonly physical: string[] } {
  const pathApi = platform === "win32" ? win32 : { join, resolve };
  const lexical = [
    pathApi.join(home, "Desktop"),
    pathApi.join(home, "Documents"),
    pathApi.join(home, "Downloads"),
    pathApi.join(home, "Music"),
    pathApi.join(home, "Movies"),
    pathApi.join(home, "Pictures"),
  ];
  const physical = [
    pathApi.join(home, ".claude"),
    pathApi.join(home, ".claude.json"),
    pathApi.join(home, ".enduragent"),
  ];
  const athleteHome = environment.ENDURAGENT_HOME;
  if (athleteHome !== undefined && athleteHome !== "") {
    physical.push(pathApi.resolve(athleteHome));
  }
  return { lexical, physical };
}

function assertNoForbiddenOverlap(
  workspace: string,
  lexicalRoots: readonly string[],
  physicalRoots: readonly string[],
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): void {
  const pathApi = platform === "win32" ? win32 : { isAbsolute, resolve };
  for (const root of lexicalRoots) {
    if (!pathApi.isAbsolute(root)) throw failure("resolve", "overlap");
    if (pathsOverlap(pathApi.resolve(root), workspace, platform)) {
      throw failure("resolve", "overlap");
    }
  }
  const physicalWorkspace = canonicalizePotentialPath(workspace, platform, fileSystem);
  for (const root of physicalRoots) {
    if (!pathApi.isAbsolute(root)) throw failure("resolve", "overlap");
    const normalized = pathApi.resolve(root);
    const physicalRoot = canonicalizePotentialPath(normalized, platform, fileSystem);
    if (
      pathsOverlap(normalized, workspace, platform) ||
      pathsOverlap(physicalRoot, physicalWorkspace, platform)
    ) {
      throw failure("resolve", "overlap");
    }
  }
}

function canonicalizePotentialPath(
  path: string,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): string {
  const pathApi = platform === "win32" ? win32 : { basename, dirname, join, resolve };
  let cursor = pathApi.resolve(path);
  const suffix: string[] = [];
  for (;;) {
    if (existingMetadata(cursor, fileSystem) !== undefined) {
      let physical: string;
      try {
        physical = fileSystem.realpathSync(cursor);
      } catch {
        throw failure("resolve", "io-failure");
      }
      return suffix.reduce((root, part) => pathApi.join(root, part), physical);
    }
    const parent = pathApi.dirname(cursor);
    if (parent === cursor) throw failure("resolve", "io-failure");
    suffix.unshift(pathApi.basename(cursor));
    cursor = parent;
  }
}

function dedicatedComponents(appRoot: string, workspace: string): string[] {
  return [appRoot, workspace];
}

function ensureContainerChain(
  container: string,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): void {
  const pathApi = platform === "win32" ? win32 : { basename, dirname, join, resolve };
  let cursor = pathApi.resolve(container);
  const missing: string[] = [];
  for (;;) {
    const metadata = existingMetadata(cursor, fileSystem);
    if (metadata !== undefined) {
      assertDirectory(metadata);
      assertCanonical(cursor, platform, fileSystem);
      break;
    }
    const parent = pathApi.dirname(cursor);
    if (parent === cursor) throw failure("prepare", "io-failure");
    missing.unshift(pathApi.basename(cursor));
    cursor = parent;
  }
  for (const part of missing) {
    cursor = pathApi.join(cursor, part);
    let metadata = existingMetadata(cursor, fileSystem);
    if (metadata === undefined) {
      try {
        fileSystem.mkdirSync(cursor, { mode: 0o700 });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw failure("prepare", "io-failure");
      }
      metadata = existingMetadata(cursor, fileSystem);
      if (metadata === undefined) throw failure("prepare", "io-failure");
    }
    assertDirectory(metadata);
    assertCanonical(cursor, platform, fileSystem);
  }
}

function createOrValidateDirectory(
  path: string,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): Stats {
  let metadata = existingMetadata(path, fileSystem);
  if (metadata === undefined) {
    try {
      fileSystem.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw failure("prepare", "io-failure");
    }
    metadata = existingMetadata(path, fileSystem);
    if (metadata === undefined) throw failure("prepare", "io-failure");
  }
  assertDirectory(metadata);
  assertCanonical(path, platform, fileSystem);
  if (platform !== "win32") assertPosixPrivate(metadata);
  assertAccess(path, fileSystem);
  return metadata;
}

function readOwnershipToken(
  path: string,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
  stage: "binding-check" | "spawn-check",
): { readonly metadata: Stats; readonly token: string } {
  const before = existingMetadata(path, fileSystem);
  if (before === undefined) throw failure(stage, "identity-changed");
  assertRegularSingleLinkFile(before);
  assertCanonical(path, platform, fileSystem);
  if (platform !== "win32") assertPosixPrivate(before);
  assertFileAccess(path, fileSystem);
  let descriptor: number | undefined;
  let token = "";
  let finalMetadata: Stats | undefined;
  try {
    const nonblocking = platform === "win32" ? 0 : constants.O_NONBLOCK;
    descriptor = fileSystem.openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | nonblocking,
    );
    const opened = fileSystem.fstatSync(descriptor);
    assertRegularSingleLinkFile(opened);
    if (!sameIdentity(identity(before), identity(opened))) {
      throw failure(stage, "identity-changed");
    }
    const content = Buffer.alloc(OWNERSHIP_TOKEN_LENGTH + 1);
    let offset = 0;
    for (;;) {
      const count = fileSystem.readSync(descriptor, content, offset, content.length - offset, null);
      if (count === 0 || offset + count === content.length) {
        offset += count;
        break;
      }
      offset += count;
    }
    if (offset !== OWNERSHIP_TOKEN_LENGTH) throw failure(stage, "identity-changed");
    token = content.toString("ascii", 0, offset);
    if (!/^[0-9a-f]+$/.test(token)) throw failure(stage, "identity-changed");
    const afterRead = fileSystem.fstatSync(descriptor);
    assertRegularSingleLinkFile(afterRead);
    if (!sameIdentity(identity(opened), identity(afterRead))) {
      throw failure(stage, "identity-changed");
    }
    const after = existingMetadata(path, fileSystem);
    if (after === undefined) throw failure(stage, "identity-changed");
    assertRegularSingleLinkFile(after);
    if (!sameIdentity(identity(before), identity(after))) {
      throw failure(stage, "identity-changed");
    }
    if (platform !== "win32") assertPosixPrivate(after);
    assertFileAccess(path, fileSystem);
    finalMetadata = after;
  } catch (error) {
    if (error instanceof ClaudeWorkingAreaError) throw error;
    throw failure(stage, errorCode(error) === "ELOOP" ? "link-reparse" : "io-failure");
  } finally {
    if (descriptor !== undefined) {
      try {
        fileSystem.closeSync(descriptor);
      } catch {
        throw failure(stage, "io-failure");
      }
    }
  }
  if (finalMetadata === undefined) throw failure(stage, "identity-changed");
  return { metadata: finalMetadata, token };
}

function waitForOwnershipMarker(
  path: string,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): boolean {
  for (let attempt = 0; attempt <= OWNERSHIP_PUBLICATION_RETRY_COUNT; attempt += 1) {
    if (existingMetadata(path, fileSystem) !== undefined) {
      readOwnershipToken(path, platform, fileSystem, "binding-check");
      return true;
    }
    if (attempt < OWNERSHIP_PUBLICATION_RETRY_COUNT) {
      Atomics.wait(ownershipPublicationWait, 0, 0, OWNERSHIP_PUBLICATION_RETRY_DELAY_MS);
    }
  }
  return false;
}

type PendingRecovery = "published" | "removed" | "missing";

function recoverPendingOwnershipMarker(
  pending: string,
  path: string,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): PendingRecovery {
  const before = existingMetadata(pending, fileSystem);
  if (before === undefined) {
    if (existingMetadata(path, fileSystem) === undefined) return "missing";
    readOwnershipToken(path, platform, fileSystem, "binding-check");
    return "published";
  }
  assertRegularSingleLinkFile(before);
  assertCanonical(pending, platform, fileSystem);
  if (platform !== "win32") assertPosixPrivate(before);
  assertFileAccess(pending, fileSystem);
  const expectedIdentity = identity(before);
  try {
    readOwnershipToken(pending, platform, fileSystem, "binding-check");
  } catch (error) {
    if (!(error instanceof ClaudeWorkingAreaError) || error.category !== "identity-changed") {
      throw error;
    }
    if (existingMetadata(path, fileSystem) !== undefined) {
      readOwnershipToken(path, platform, fileSystem, "binding-check");
      return "published";
    }
    const current = existingMetadata(pending, fileSystem);
    if (current === undefined) return "missing";
    assertRegularSingleLinkFile(current);
    assertCanonical(pending, platform, fileSystem);
    if (platform !== "win32") assertPosixPrivate(current);
    assertFileAccess(pending, fileSystem);
    if (!sameIdentity(expectedIdentity, identity(current))) {
      throw failure("binding-check", "identity-changed");
    }
    try {
      fileSystem.unlinkSync(pending);
    } catch (unlinkError) {
      if (errorCode(unlinkError) !== "ENOENT") throw failure("prepare", "io-failure");
      if (existingMetadata(path, fileSystem) !== undefined) {
        readOwnershipToken(path, platform, fileSystem, "binding-check");
        return "published";
      }
      return "missing";
    }
    return "removed";
  }
  const current = existingMetadata(pending, fileSystem);
  if (current === undefined) {
    if (existingMetadata(path, fileSystem) === undefined) return "missing";
    readOwnershipToken(path, platform, fileSystem, "binding-check");
    return "published";
  }
  assertRegularSingleLinkFile(current);
  assertCanonical(pending, platform, fileSystem);
  if (platform !== "win32") assertPosixPrivate(current);
  assertFileAccess(pending, fileSystem);
  if (!sameIdentity(expectedIdentity, identity(current))) {
    throw failure("binding-check", "identity-changed");
  }
  try {
    fileSystem.renameSync(pending, path);
  } catch (error) {
    if (existingMetadata(path, fileSystem) !== undefined) {
      readOwnershipToken(path, platform, fileSystem, "binding-check");
      return "published";
    }
    if (errorCode(error) === "ENOENT" && existingMetadata(pending, fileSystem) === undefined) {
      return "missing";
    }
    throw failure("prepare", "io-failure");
  }
  readOwnershipToken(path, platform, fileSystem, "binding-check");
  return "published";
}

function createOrValidateOwnershipMarker(
  path: string,
  workspace: string,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): void {
  if (existingMetadata(path, fileSystem) !== undefined) {
    readOwnershipToken(path, platform, fileSystem, "binding-check");
    return;
  }
  const pathApi = platform === "win32" ? win32 : { basename };
  const pending = `${path}.pending`;
  let publicationWaitAvailable = true;
  for (
    let publicationAttempt = 0;
    publicationAttempt < OWNERSHIP_PUBLICATION_ATTEMPT_COUNT;
    publicationAttempt += 1
  ) {
    if (existingMetadata(path, fileSystem) !== undefined) {
      readOwnershipToken(path, platform, fileSystem, "binding-check");
      return;
    }
    let entries: string[];
    try {
      entries = fileSystem.readdirSync(workspace);
    } catch {
      throw failure("entry-check", "io-failure");
    }
    if (
      entries.length !== 0 &&
      !(entries.length === 1 && entries[0] === pathApi.basename(pending))
    ) {
      if (existingMetadata(path, fileSystem) !== undefined) {
        readOwnershipToken(path, platform, fileSystem, "binding-check");
        return;
      }
      throw failure("entry-check", "not-empty");
    }
    let writeFailure: unknown;
    try {
      fileSystem.writeFileSync(pending, randomBytes(OWNERSHIP_TOKEN_BYTES).toString("hex"), {
        encoding: "ascii",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      writeFailure = error;
    }
    if (errorCode(writeFailure) === "EEXIST") {
      if (!publicationWaitAvailable) throw failure("binding-check", "identity-changed");
      publicationWaitAvailable = false;
      if (waitForOwnershipMarker(path, platform, fileSystem)) return;
    }
    const recovery = recoverPendingOwnershipMarker(pending, path, platform, fileSystem);
    if (recovery === "published") return;
    if (publicationAttempt + 1 < OWNERSHIP_PUBLICATION_ATTEMPT_COUNT) continue;
    throw failure(
      errorCode(writeFailure) === "EEXIST" ? "binding-check" : "prepare",
      errorCode(writeFailure) === "EEXIST" ? "identity-changed" : "io-failure",
    );
  }
  throw failure("prepare", "io-failure");
}

function assertBoundDirectory(
  path: string,
  expectedIdentity: PathIdentity,
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): void {
  const current = fileSystem.lstatSync(path);
  assertDirectory(current);
  assertCanonical(path, platform, fileSystem);
  if (!sameIdentity(expectedIdentity, identity(current))) {
    throw failure("spawn-check", "identity-changed");
  }
  if (platform !== "win32") assertPosixPrivate(current);
  assertAccess(path, fileSystem);
}

function bindWorkingArea(
  workspace: string,
  ownershipMarker: string,
  lexicalForbiddenRoots: readonly string[],
  physicalForbiddenRoots: readonly string[],
  platform: NodeJS.Platform,
  fileSystem: ClaudeWorkingAreaFileSystem,
): ClaudeWorkingAreaBinding {
  assertNoForbiddenOverlap(
    workspace,
    lexicalForbiddenRoots,
    physicalForbiddenRoots,
    platform,
    fileSystem,
  );
  const pathApi = platform === "win32" ? win32 : { dirname };
  const target = createOrValidateDirectory(workspace, platform, fileSystem);
  const parentPath = pathApi.dirname(workspace);
  const parent = createOrValidateDirectory(parentPath, platform, fileSystem);
  const marker = readOwnershipToken(ownershipMarker, platform, fileSystem, "binding-check");
  const targetIdentity = identity(target);
  const parentIdentity = identity(parent);
  const markerIdentity = identity(marker.metadata);
  const markerToken = marker.token;
  return Object.freeze({
    cwd: workspace,
    assertCurrent() {
      try {
        assertNoForbiddenOverlap(
          workspace,
          lexicalForbiddenRoots,
          physicalForbiddenRoots,
          platform,
          fileSystem,
        );
        assertBoundDirectory(workspace, targetIdentity, platform, fileSystem);
        assertBoundDirectory(parentPath, parentIdentity, platform, fileSystem);
        const currentMarker = readOwnershipToken(
          ownershipMarker,
          platform,
          fileSystem,
          "spawn-check",
        );
        if (
          !sameIdentity(markerIdentity, identity(currentMarker.metadata)) ||
          markerToken !== currentMarker.token
        ) {
          throw failure("spawn-check", "identity-changed");
        }
        assertBoundDirectory(workspace, targetIdentity, platform, fileSystem);
        assertBoundDirectory(parentPath, parentIdentity, platform, fileSystem);
      } catch (error) {
        if (error instanceof ClaudeWorkingAreaError) throw error;
        throw failure("spawn-check", "io-failure");
      }
    },
  });
}

export function createClaudeWorkingArea(
  input: CreateClaudeWorkingAreaInput = {},
): ClaudeWorkingAreaPort {
  const platform = input.platform ?? process.platform;
  const environment = input.environment ?? process.env;
  const fileSystem = { ...nodeFileSystem, ...input.fileSystem };
  const resolved = resolveClaudeWorkingAreaPath({
    platform,
    environment,
    ...(input.homeDirectory === undefined ? {} : { homeDirectory: input.homeDirectory }),
  });
  const filesystemRoot =
    platform === "win32" ? win32.parse(resolved.workspace).root : parse(resolved.workspace).root;
  if (pathEquals(resolved.workspace, filesystemRoot, platform)) throw failure("resolve", "root");
  if (pathEquals(resolved.workspace, resolved.home, platform)) throw failure("resolve", "root");
  const defaultRoots = defaultForbiddenRoots(resolved.home, environment, platform);
  const lexicalForbiddenRoots = defaultRoots.lexical;
  const physicalForbiddenRoots = [...defaultRoots.physical, ...(input.forbiddenRoots ?? [])];
  const configuredConfigDir =
    input.configDir !== undefined && input.configDir !== ""
      ? input.configDir
      : readEnvironmentValue(environment, "CLAUDE_CONFIG_DIR", platform);
  if (configuredConfigDir !== undefined && configuredConfigDir !== "") {
    physicalForbiddenRoots.push(
      resolveClaudeConfigDir(configuredConfigDir, {
        platform,
        env: environment,
        home: resolved.home,
      }),
    );
  }
  assertNoForbiddenOverlap(
    resolved.workspace,
    lexicalForbiddenRoots,
    physicalForbiddenRoots,
    platform,
    fileSystem,
  );
  let preparing: Promise<void> | null = null;
  const pathApi = platform === "win32" ? win32 : { dirname, join };
  const ownershipMarker = pathApi.join(resolved.workspace, OWNERSHIP_MARKER_NAME);

  const prepare = (): void => {
    assertNoForbiddenOverlap(
      resolved.workspace,
      lexicalForbiddenRoots,
      physicalForbiddenRoots,
      platform,
      fileSystem,
    );
    assertCanonical(resolved.home, platform, fileSystem);
    ensureContainerChain(pathApi.dirname(resolved.appRoot), platform, fileSystem);
    for (const component of dedicatedComponents(resolved.appRoot, resolved.workspace)) {
      createOrValidateDirectory(component, platform, fileSystem);
    }
    createOrValidateOwnershipMarker(ownershipMarker, resolved.workspace, platform, fileSystem);
    if (hasRepositoryAncestor(resolved.workspace, platform, fileSystem)) {
      throw failure("prepare", "repository");
    }
    assertNoForbiddenOverlap(
      resolved.workspace,
      lexicalForbiddenRoots,
      physicalForbiddenRoots,
      platform,
      fileSystem,
    );
  };

  return Object.freeze({
    cacheKey: resolved.workspace,
    async prepareForLaunch() {
      preparing ??= Promise.resolve()
        .then(() => prepare())
        .finally(() => {
          preparing = null;
        });
      await preparing;
      return bindWorkingArea(
        resolved.workspace,
        ownershipMarker,
        lexicalForbiddenRoots,
        physicalForbiddenRoots,
        platform,
        fileSystem,
      );
    },
  });
}
