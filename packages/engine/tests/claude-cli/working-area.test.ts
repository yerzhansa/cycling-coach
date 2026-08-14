import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeWorkingAreaError } from "../../src/agent/claude-cli/errors.js";
import {
  createClaudeWorkingArea,
  resolveClaudeWorkingAreaPath,
  type ClaudeWorkingAreaFileSystem,
} from "../../src/agent/claude-cli/working-area.js";

const scratch: string[] = [];

afterEach(() => {
  while (scratch.length > 0) {
    const path = scratch.pop();
    if (path !== undefined) rmSync(path, { recursive: true, force: true });
  }
});

function testHome(): string {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "enduragent-claude-area-")));
  chmodSync(home, 0o700);
  scratch.push(home);
  return home;
}

function windowsFileSystem(
  home: string,
  localAppData: string,
): {
  readonly fileSystem: ClaudeWorkingAreaFileSystem;
  replace(path: string): void;
} {
  type Entry = { path: string; metadata: Stats; content?: Buffer };
  let nextIdentity = 20;
  let nextDescriptor = 100;
  const entries = new Map<string, Entry>();
  const descriptors = new Map<number, { entry: Entry; offset: number }>();
  const key = (path: string): string => win32.normalize(path).toLowerCase();
  const samePath = (left: string, right: string): boolean => key(left) === key(right);
  const metadata = (
    identity: number,
    type: "directory" | "file" | "symbolic-link" = "directory",
    mode = 0,
  ): Stats =>
    ({
      dev: 5,
      ino: identity,
      mode,
      uid: 0,
      nlink: 1,
      isDirectory: () => type === "directory",
      isFile: () => type === "file",
      isSymbolicLink: () => type === "symbolic-link",
    }) as Stats;
  const addDirectory = (path: string): void => {
    entries.set(key(path), { path, metadata: metadata(nextIdentity++) });
  };
  for (const path of [
    win32.parse(home).root,
    win32.parse(localAppData).root,
    win32.dirname(home),
    home,
    win32.dirname(win32.dirname(localAppData)),
    win32.dirname(localAppData),
    localAppData,
  ]) {
    addDirectory(path);
  }
  const missing = (): NodeJS.ErrnoException =>
    Object.assign(new Error("missing"), { code: "ENOENT" });
  return {
    fileSystem: {
      accessSync() {},
      closeSync(descriptor: number) {
        descriptors.delete(descriptor);
      },
      fstatSync(descriptor: number) {
        const opened = descriptors.get(descriptor);
        if (opened === undefined) throw missing();
        return opened.entry.metadata;
      },
      lstatSync(path: Parameters<typeof lstatSync>[0]) {
        const entry = entries.get(key(String(path)));
        if (entry === undefined) throw missing();
        return entry.metadata;
      },
      mkdirSync(path: Parameters<typeof mkdirSync>[0]) {
        addDirectory(String(path));
        return String(path);
      },
      openSync(path: Parameters<typeof openSync>[0]) {
        const entryKey = key(String(path));
        const entry = entries.get(entryKey);
        if (entry === undefined) throw missing();
        const descriptor = nextDescriptor++;
        descriptors.set(descriptor, { entry, offset: 0 });
        return descriptor;
      },
      readSync(descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number) {
        const opened = descriptors.get(descriptor);
        if (opened?.entry.content === undefined) throw missing();
        const target = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const count = opened.entry.content.copy(
          target,
          offset,
          opened.offset,
          opened.offset + length,
        );
        opened.offset += count;
        return count;
      },
      readdirSync(path: Parameters<ClaudeWorkingAreaFileSystem["readdirSync"]>[0]) {
        const parent = String(path);
        return [...entries.values()]
          .filter((entry) => !samePath(entry.path, parent))
          .filter((entry) => samePath(win32.dirname(entry.path), parent))
          .map((entry) => win32.basename(entry.path));
      },
      realpathSync(path: Parameters<typeof realpathSync>[0]) {
        const entry = entries.get(key(String(path)));
        if (entry === undefined) throw missing();
        return entry.path;
      },
      renameSync(
        oldPath: Parameters<typeof renameSync>[0],
        newPath: Parameters<typeof renameSync>[1],
      ) {
        const oldKey = key(String(oldPath));
        const entry = entries.get(oldKey);
        if (entry === undefined) throw missing();
        entries.delete(oldKey);
        entry.path = String(newPath);
        entries.set(key(String(newPath)), entry);
      },
      unlinkSync(path: Parameters<typeof unlinkSync>[0]) {
        if (!entries.delete(key(String(path)))) throw missing();
      },
      writeFileSync(
        path: Parameters<typeof writeFileSync>[0],
        data: string | NodeJS.ArrayBufferView,
      ) {
        const entryKey = key(String(path));
        if (entries.has(entryKey)) {
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }
        entries.set(entryKey, {
          path: String(path),
          metadata: metadata(nextIdentity++, "file", 0o600),
          content: typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer),
        });
      },
    } as unknown as ClaudeWorkingAreaFileSystem,
    replace(path) {
      entries.set(key(path), { path, metadata: metadata(nextIdentity++) });
    },
  };
}

function area(home: string, forbiddenRoots: readonly string[] = []) {
  return createClaudeWorkingArea({
    platform: "linux",
    homeDirectory: home,
    environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
    forbiddenRoots,
  });
}

function paths(home: string): {
  readonly appRoot: string;
  readonly workspace: string;
  readonly marker: string;
} {
  const resolved = resolveClaudeWorkingAreaPath({
    platform: "linux",
    homeDirectory: home,
    environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
  });
  return {
    appRoot: resolved.appRoot,
    workspace: resolved.workspace,
    marker: join(resolved.workspace, ".enduragent-ownership"),
  };
}

function withIdentity(metadata: Stats, dev: number | bigint, ino: number | bigint): Stats {
  return new Proxy(metadata, {
    get(target, property) {
      if (property === "dev") return dev;
      if (property === "ino") return ino;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("Claude private working area", () => {
  it("uses stable platform-specific cache locations", () => {
    expect(
      resolveClaudeWorkingAreaPath({
        platform: "darwin",
        homeDirectory: "/Users/rider",
        environment: { HOME: "/Users/rider" },
      }).workspace,
    ).toBe("/Users/rider/Library/Caches/Enduragent/claude/workspace");
    expect(
      resolveClaudeWorkingAreaPath({
        platform: "linux",
        homeDirectory: "/home/rider",
        environment: { HOME: "/home/rider" },
      }).workspace,
    ).toBe("/home/rider/.cache/enduragent/claude/workspace");
    expect(
      resolveClaudeWorkingAreaPath({
        platform: "win32",
        homeDirectory: "C:\\Users\\Rider",
        environment: {
          USERPROFILE: "C:\\Users\\Rider",
          LOCALAPPDATA: "C:\\Users\\Rider\\AppData\\Local",
        },
      }).workspace,
    ).toBe("C:\\Users\\Rider\\AppData\\Local\\Enduragent Claude\\workspace");
  });

  it("treats an empty XDG cache root as absent", () => {
    expect(
      resolveClaudeWorkingAreaPath({
        platform: "linux",
        homeDirectory: "/home/rider",
        environment: { HOME: "/home/rider", XDG_CACHE_HOME: "" },
      }),
    ).toMatchObject({
      cacheRoot: "/home/rider/.cache",
      workspace: "/home/rider/.cache/enduragent/claude/workspace",
    });
  });

  it("creates a missing cache root outside home", async () => {
    const home = testHome();
    const externalParent = realpathSync(mkdtempSync(join(tmpdir(), "enduragent-cache-root-")));
    scratch.push(externalParent);
    const cacheRoot = join(externalParent, "missing", "cache");
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: cacheRoot },
    });

    const binding = await workingArea.prepareForLaunch("generation");

    expect(binding.cwd).toBe(join(cacheRoot, "enduragent", "claude", "workspace"));
    expect(() => binding.assertCurrent()).not.toThrow();
  });

  it("refuses filesystem roots and Windows network paths as cache roots", () => {
    expect(() =>
      resolveClaudeWorkingAreaPath({
        platform: "linux",
        homeDirectory: "/home/rider",
        environment: { HOME: "/home/rider", XDG_CACHE_HOME: "/" },
      }),
    ).toThrowError(ClaudeWorkingAreaError);
    for (const localAppData of ["D:\\", "\\\\server\\share\\cache", "\\\\?\\C:\\cache"]) {
      expect(() =>
        resolveClaudeWorkingAreaPath({
          platform: "win32",
          homeDirectory: "C:\\Users\\Rider",
          environment: { USERPROFILE: "C:\\Users\\Rider", LOCALAPPDATA: localAppData },
        }),
      ).toThrowError(ClaudeWorkingAreaError);
    }
  });

  it("refuses a symbolic-link cache ancestor outside home", async () => {
    const home = testHome();
    const externalParent = realpathSync(mkdtempSync(join(tmpdir(), "enduragent-cache-link-")));
    scratch.push(externalParent);
    const target = join(externalParent, "target");
    const cacheRoot = join(externalParent, "cache");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, cacheRoot);
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: cacheRoot },
    });

    await expect(workingArea.prepareForLaunch("generation")).rejects.toMatchObject({
      category: "link-reparse",
    });
  });

  it("creates and reuses a current-user-only working area", async () => {
    const home = testHome();
    const workingArea = area(home);
    const first = await workingArea.prepareForLaunch("version");
    writeFileSync(join(first.cwd, "claude-operational-artifact"), "disposable");
    const second = await workingArea.prepareForLaunch("generation");

    expect(first.cwd).toBe(paths(home).workspace);
    expect(second.cwd).toBe(first.cwd);
    expect(lstatSync(first.cwd).mode & 0o077).toBe(0);
    expect(lstatSync(join(first.cwd, "..")).mode & 0o077).toBe(0);
    expect(lstatSync(paths(home).marker).isFile()).toBe(true);
    expect(lstatSync(paths(home).marker).mode & 0o077).toBe(0);
    expect(() => first.assertCurrent()).not.toThrow();
    expect(() => second.assertCurrent()).not.toThrow();
  });

  it("keeps the ownership descriptor open through final pathname validation", async () => {
    const home = testHome();
    const marker = paths(home).marker;
    const markerDescriptors = new Set<number>();
    let active = false;
    let markerRead = false;
    let observedOpenPathValidation = false;
    const observedOpen = ((
      path: Parameters<typeof openSync>[0],
      flags: Parameters<typeof openSync>[1],
      mode?: Parameters<typeof openSync>[2],
    ) => {
      const descriptor = openSync(path, flags, mode);
      if (String(path) === marker) markerDescriptors.add(descriptor);
      return descriptor;
    }) as typeof openSync;
    const observedRead = ((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const count = readSync(descriptor, buffer, offset, length, position);
      if (active && markerDescriptors.has(descriptor)) markerRead = true;
      return count;
    }) as typeof readSync;
    const observedLstat = ((path: Parameters<typeof lstatSync>[0]) => {
      if (active && String(path) === marker && markerRead && markerDescriptors.size > 0) {
        observedOpenPathValidation = true;
      }
      return lstatSync(path);
    }) as typeof lstatSync;
    const observedClose = ((descriptor: number) => {
      markerDescriptors.delete(descriptor);
      closeSync(descriptor);
    }) as typeof closeSync;
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
      fileSystem: {
        closeSync: observedClose,
        lstatSync: observedLstat,
        openSync: observedOpen,
        readSync: observedRead,
      },
    });
    const binding = await workingArea.prepareForLaunch("generation");
    active = true;

    expect(() => binding.assertCurrent()).not.toThrow();
    expect(observedOpenPathValidation).toBe(true);
  });

  it("rechecks the workspace after reading the ownership token", async () => {
    const home = testHome();
    const workspace = paths(home).workspace;
    const marker = paths(home).marker;
    const markerDescriptors = new Set<number>();
    let replaceDuringRead = false;
    let replaced = false;
    const observedOpen = ((
      path: Parameters<typeof openSync>[0],
      flags: Parameters<typeof openSync>[1],
      mode?: Parameters<typeof openSync>[2],
    ) => {
      const descriptor = openSync(path, flags, mode);
      if (String(path) === marker) markerDescriptors.add(descriptor);
      return descriptor;
    }) as typeof openSync;
    const observedRead = ((
      descriptor: number,
      buffer: NodeJS.ArrayBufferView,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const count = readSync(descriptor, buffer, offset, length, position);
      if (replaceDuringRead && markerDescriptors.has(descriptor)) replaced = true;
      return count;
    }) as typeof readSync;
    const observedLstat = ((path: Parameters<typeof lstatSync>[0]) => {
      const metadata = lstatSync(path);
      if (replaced && String(path) === workspace) {
        const ino = typeof metadata.ino === "bigint" ? metadata.ino + 1n : metadata.ino + 1;
        return withIdentity(metadata, metadata.dev, ino);
      }
      return metadata;
    }) as typeof lstatSync;
    const observedClose = ((descriptor: number) => {
      markerDescriptors.delete(descriptor);
      closeSync(descriptor);
    }) as typeof closeSync;
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
      fileSystem: {
        closeSync: observedClose,
        lstatSync: observedLstat,
        openSync: observedOpen,
        readSync: observedRead,
      },
    });
    const binding = await workingArea.prepareForLaunch("generation");
    replaceDuringRead = true;

    expect(() => binding.assertCurrent()).toThrowError(ClaudeWorkingAreaError);
  });

  it("refuses an invalid ownership marker", async () => {
    const home = testHome();
    const resolved = paths(home);
    mkdirSync(resolved.workspace, { recursive: true, mode: 0o700 });
    writeFileSync(resolved.marker, "invalid", { mode: 0o600 });

    await expect(area(home).prepareForLaunch("generation")).rejects.toMatchObject({
      category: "identity-changed",
    });
  });

  it("waits for an in-progress initializer to publish a complete marker", async () => {
    const home = testHome();
    const resolved = paths(home);
    const pending = `${resolved.marker}.pending`;
    mkdirSync(resolved.workspace, { recursive: true, mode: 0o700 });
    writeFileSync(pending, "partial", { mode: 0o600 });
    let publicationInProgress = false;
    const observedWrite = ((
      path: Parameters<typeof writeFileSync>[0],
      data: Parameters<typeof writeFileSync>[1],
      options?: Parameters<typeof writeFileSync>[2],
    ) => {
      try {
        writeFileSync(path, data, options);
      } catch (error) {
        if (String(path) === pending && (error as NodeJS.ErrnoException).code === "EEXIST") {
          publicationInProgress = true;
        }
        throw error;
      }
    }) as typeof writeFileSync;
    const observedLstat = ((path: Parameters<typeof lstatSync>[0]) => {
      if (String(path) === resolved.marker && publicationInProgress) {
        writeFileSync(pending, "a".repeat(64), { mode: 0o600 });
        renameSync(pending, resolved.marker);
        publicationInProgress = false;
      }
      return lstatSync(path);
    }) as typeof lstatSync;
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
      fileSystem: { lstatSync: observedLstat, writeFileSync: observedWrite },
    });

    const binding = await workingArea.prepareForLaunch("generation");

    expect(() => binding.assertCurrent()).not.toThrow();
    expect(() => lstatSync(pending)).toThrow();
  });

  it("recovers a stale complete pending marker", async () => {
    const home = testHome();
    const resolved = paths(home);
    const pending = `${resolved.marker}.pending`;
    mkdirSync(resolved.workspace, { recursive: true, mode: 0o700 });
    writeFileSync(pending, "c".repeat(64), { mode: 0o600 });

    const binding = await area(home).prepareForLaunch("generation");

    expect(() => binding.assertCurrent()).not.toThrow();
    expect(lstatSync(resolved.marker).isFile()).toBe(true);
    expect(() => lstatSync(pending)).toThrow();
  });

  it("removes a stale partial pending marker and retries publication", async () => {
    const home = testHome();
    const resolved = paths(home);
    const pending = `${resolved.marker}.pending`;
    mkdirSync(resolved.workspace, { recursive: true, mode: 0o700 });
    writeFileSync(pending, "partial", { mode: 0o600 });

    const binding = await area(home).prepareForLaunch("generation");

    expect(() => binding.assertCurrent()).not.toThrow();
    expect(lstatSync(resolved.marker).isFile()).toBe(true);
    expect(() => lstatSync(pending)).toThrow();
  });

  it("cleans an unchanged partial pending marker after a write failure", async () => {
    const home = testHome();
    const resolved = paths(home);
    const pending = `${resolved.marker}.pending`;
    let injectFailure = true;
    const observedWrite = ((
      path: Parameters<typeof writeFileSync>[0],
      data: Parameters<typeof writeFileSync>[1],
      options?: Parameters<typeof writeFileSync>[2],
    ) => {
      if (injectFailure && String(path) === pending) {
        injectFailure = false;
        writeFileSync(path, "partial", options);
        throw Object.assign(new Error("partial write"), { code: "EIO" });
      }
      writeFileSync(path, data, options);
    }) as typeof writeFileSync;
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
      fileSystem: { writeFileSync: observedWrite },
    });

    const binding = await workingArea.prepareForLaunch("generation");

    expect(injectFailure).toBe(false);
    expect(() => binding.assertCurrent()).not.toThrow();
    expect(() => lstatSync(pending)).toThrow();
  });

  it("exhausts the bounded publisher wait before taking over a stale marker", async () => {
    const home = testHome();
    const resolved = paths(home);
    const pending = `${resolved.marker}.pending`;
    mkdirSync(resolved.workspace, { recursive: true, mode: 0o700 });
    writeFileSync(pending, "partial", { mode: 0o600 });
    let missingMarkerChecks = 0;
    const observedLstat = ((path: Parameters<typeof lstatSync>[0]) => {
      try {
        return lstatSync(path);
      } catch (error) {
        if (
          String(path) === resolved.marker &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          missingMarkerChecks += 1;
        }
        throw error;
      }
    }) as typeof lstatSync;
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
      fileSystem: { lstatSync: observedLstat },
    });

    const binding = await workingArea.prepareForLaunch("generation");

    expect(missingMarkerChecks).toBeGreaterThanOrEqual(20);
    expect(() => binding.assertCurrent()).not.toThrow();
  });

  it("refuses the default Claude configuration tree as a cache root", () => {
    const home = testHome();
    expect(() =>
      createClaudeWorkingArea({
        platform: "linux",
        homeDirectory: home,
        environment: { HOME: home, XDG_CACHE_HOME: join(home, ".claude") },
      }),
    ).toThrowError(ClaudeWorkingAreaError);

    writeFileSync(join(home, ".claude.json"), "{}");
    expect(() =>
      createClaudeWorkingArea({
        platform: "linux",
        homeDirectory: home,
        environment: { HOME: home, XDG_CACHE_HOME: join(home, ".claude.json") },
      }),
    ).toThrowError(ClaudeWorkingAreaError);
  });

  it("does not inspect protected personal folders while validating separation", async () => {
    const home = testHome();
    const inspected: string[] = [];
    const observedLstat = ((path: Parameters<typeof lstatSync>[0]) => {
      const value = String(path);
      inspected.push(value);
      if (value === join(home, "Documents")) throw new Error("protected folder touched");
      return lstatSync(path);
    }) as typeof lstatSync;
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
      fileSystem: { lstatSync: observedLstat },
    });

    await expect(workingArea.prepareForLaunch("generation")).resolves.toBeDefined();
    expect(inspected).not.toContain(join(home, "Documents"));
  });

  it("binds a Windows working area inside the ordinary per-user profile", async () => {
    const home = "C:\\Users\\骑手";
    const localAppData = win32.join(home, "AppData", "Local");
    const fake = windowsFileSystem(home, localAppData);
    const workingArea = createClaudeWorkingArea({
      platform: "win32",
      homeDirectory: home,
      environment: { USERPROFILE: home, LOCALAPPDATA: localAppData },
      fileSystem: fake.fileSystem,
    });

    const binding = await workingArea.prepareForLaunch("generation");
    expect(binding.cwd).toBe(win32.join(localAppData, "Enduragent Claude", "workspace"));
    expect(() => binding.assertCurrent()).not.toThrow();
    fake.replace(binding.cwd);
    expect(() => binding.assertCurrent()).toThrowError(ClaudeWorkingAreaError);
  });

  it("binds a Windows working area on a different local drive", async () => {
    const home = "C:\\Users\\Rider";
    const localAppData = "D:\\Profiles\\Rider\\AppData\\Local";
    const fake = windowsFileSystem(home, localAppData);
    const workingArea = createClaudeWorkingArea({
      platform: "win32",
      homeDirectory: home,
      environment: { USERPROFILE: home, LOCALAPPDATA: localAppData },
      fileSystem: fake.fileSystem,
    });

    const binding = await workingArea.prepareForLaunch("generation");

    expect(binding.cwd).toBe(win32.join(localAppData, "Enduragent Claude", "workspace"));
    expect(() => binding.assertCurrent()).not.toThrow();
  });

  it("refuses an existing working area that is not private", async () => {
    const home = testHome();
    const resolved = paths(home);
    mkdirSync(resolved.appRoot, { recursive: true, mode: 0o700 });
    mkdirSync(resolved.workspace, { mode: 0o755 });

    await expect(area(home).prepareForLaunch("account")).rejects.toMatchObject({
      kind: "working-area-unavailable",
      stage: "permission-check",
      category: "permissions",
    });
    expect(lstatSync(resolved.workspace).mode & 0o077).not.toBe(0);
  });

  it("refuses files and symbolic links without replacing them", async () => {
    const fileHome = testHome();
    const filePaths = paths(fileHome);
    mkdirSync(filePaths.appRoot, { recursive: true, mode: 0o700 });
    writeFileSync(filePaths.workspace, "not a directory");
    await expect(area(fileHome).prepareForLaunch("account")).rejects.toMatchObject({
      category: "entry-type",
    });

    const linkHome = testHome();
    const linkPaths = paths(linkHome);
    const target = join(linkHome, "target");
    mkdirSync(linkPaths.appRoot, { recursive: true, mode: 0o700 });
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, linkPaths.workspace);
    await expect(area(linkHome).prepareForLaunch("account")).rejects.toMatchObject({
      category: "link-reparse",
    });
  });

  it("refuses a working area that already contains unrelated content", async () => {
    const home = testHome();
    const resolved = paths(home);
    mkdirSync(resolved.workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(resolved.workspace, "athlete-export.fit"), "private");

    await expect(area(home).prepareForLaunch("generation")).rejects.toMatchObject({
      kind: "working-area-unavailable",
      stage: "entry-check",
      category: "not-empty",
    });
  });

  it("refuses a forbidden athlete-data overlap before creating a directory", () => {
    const home = testHome();
    const resolved = paths(home);
    expect(() => area(home, [join(home, ".cache")])).toThrowError(ClaudeWorkingAreaError);
    expect(() => lstatSync(resolved.workspace)).toThrow();
  });

  it("refuses physical forbidden-root aliases", () => {
    const home = testHome();
    const resolved = paths(home);
    mkdirSync(resolved.workspace, { recursive: true, mode: 0o700 });
    const alias = join(home, "athlete-alias");
    symlinkSync(resolved.appRoot, alias);

    expect(() => area(home, [join(alias, "workspace")])).toThrowError(ClaudeWorkingAreaError);
  });

  it("rechecks physical forbidden-root aliases before spawn", async () => {
    const home = testHome();
    const forbidden = join(home, "athlete-data");
    mkdirSync(forbidden, { mode: 0o700 });
    const binding = await area(home, [forbidden]).prepareForLaunch("generation");
    rmSync(forbidden, { recursive: true });
    symlinkSync(binding.cwd, forbidden);

    expect(() => binding.assertCurrent()).toThrowError(ClaudeWorkingAreaError);
  });

  it("refuses explicit and environment-owned Claude configuration overlap", () => {
    const home = testHome();
    const workspace = paths(home).workspace;
    expect(() =>
      createClaudeWorkingArea({
        platform: "linux",
        homeDirectory: home,
        environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
        configDir: workspace,
      }),
    ).toThrowError(ClaudeWorkingAreaError);
    expect(() =>
      createClaudeWorkingArea({
        platform: "linux",
        homeDirectory: home,
        environment: {
          HOME: home,
          XDG_CACHE_HOME: join(home, ".cache"),
          CLAUDE_CONFIG_DIR: workspace,
        },
      }),
    ).toThrowError(ClaudeWorkingAreaError);
  });

  it("refuses a repository ancestor", async () => {
    const home = testHome();
    mkdirSync(join(home, ".git"), { mode: 0o700 });
    await expect(area(home).prepareForLaunch("generation")).rejects.toMatchObject({
      category: "repository",
    });
  });

  it("detects deletion and replacement after preparation", async () => {
    const home = testHome();
    const binding = await area(home).prepareForLaunch("generation");
    rmSync(binding.cwd, { recursive: true });
    mkdirSync(binding.cwd, { mode: 0o700 });

    expect(() => binding.assertCurrent()).toThrowError(ClaudeWorkingAreaError);
  });

  it("detects ownership-marker replacement after preparation", async () => {
    const home = testHome();
    const binding = await area(home).prepareForLaunch("generation");
    const marker = paths(home).marker;
    rmSync(marker, { recursive: true });
    mkdirSync(marker, { mode: 0o700 });

    expect(() => binding.assertCurrent()).toThrowError(ClaudeWorkingAreaError);
  });

  it("detects ownership-marker replacement from the open hook", async () => {
    const home = testHome();
    const marker = paths(home).marker;
    let replaceOnOpen = false;
    const observedOpen = ((
      path: Parameters<typeof openSync>[0],
      flags: Parameters<typeof openSync>[1],
      mode?: Parameters<typeof openSync>[2],
    ) => {
      if (replaceOnOpen && String(path) === marker) {
        replaceOnOpen = false;
        rmSync(marker);
        writeFileSync(marker, "b".repeat(64), { mode: 0o600 });
      }
      return openSync(path, flags, mode);
    }) as typeof openSync;
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
      fileSystem: { openSync: observedOpen },
    });
    const binding = await workingArea.prepareForLaunch("generation");
    replaceOnOpen = true;

    expect(() => binding.assertCurrent()).toThrowError(ClaudeWorkingAreaError);
  });

  it("opens a possible FIFO marker in nonblocking mode before rejecting it", async () => {
    const home = testHome();
    const marker = paths(home).marker;
    const syntheticDescriptor = 987_654;
    let substituteFifo = false;
    let observedFlags: number | undefined;
    const observedOpen = ((
      path: Parameters<typeof openSync>[0],
      flags: Parameters<typeof openSync>[1],
      mode?: Parameters<typeof openSync>[2],
    ) => {
      if (substituteFifo && String(path) === marker) {
        observedFlags = typeof flags === "number" ? flags : undefined;
        return syntheticDescriptor;
      }
      return openSync(path, flags, mode);
    }) as typeof openSync;
    const observedFstat = ((descriptor: number) => {
      if (descriptor === syntheticDescriptor) {
        const metadata = lstatSync(marker);
        return new Proxy(metadata, {
          get(target, property) {
            if (property === "isFile") return () => false;
            if (property === "isDirectory") return () => false;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      return fstatSync(descriptor);
    }) as typeof fstatSync;
    const observedClose = ((descriptor: number) => {
      if (descriptor !== syntheticDescriptor) closeSync(descriptor);
    }) as typeof closeSync;
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
      fileSystem: {
        closeSync: observedClose,
        fstatSync: observedFstat,
        openSync: observedOpen,
      },
    });
    const binding = await workingArea.prepareForLaunch("generation");
    substituteFifo = true;

    expect(() => binding.assertCurrent()).toThrowError(ClaudeWorkingAreaError);
    expect(observedFlags).toBeDefined();
    expect((observedFlags ?? 0) & constants.O_NONBLOCK).not.toBe(0);
  });

  it("detects replacement when device and inode identities are reused", async () => {
    const home = testHome();
    const forcedIdentities = new Map<string, { dev: number | bigint; ino: number | bigint }>();
    const descriptorPaths = new Map<number, string>();
    const observedLstat = ((path: Parameters<typeof lstatSync>[0]) => {
      const value = String(path);
      const metadata = lstatSync(path);
      const forced = forcedIdentities.get(value);
      return forced === undefined ? metadata : withIdentity(metadata, forced.dev, forced.ino);
    }) as typeof lstatSync;
    const observedOpen = ((
      path: Parameters<typeof openSync>[0],
      flags: Parameters<typeof openSync>[1],
      mode?: Parameters<typeof openSync>[2],
    ) => {
      const descriptor = openSync(path, flags, mode);
      descriptorPaths.set(descriptor, String(path));
      return descriptor;
    }) as typeof openSync;
    const observedFstat = ((descriptor: number) => {
      const metadata = fstatSync(descriptor);
      const path = descriptorPaths.get(descriptor);
      const forced = path === undefined ? undefined : forcedIdentities.get(path);
      return forced === undefined ? metadata : withIdentity(metadata, forced.dev, forced.ino);
    }) as typeof fstatSync;
    const observedClose = ((descriptor: number) => {
      descriptorPaths.delete(descriptor);
      closeSync(descriptor);
    }) as typeof closeSync;
    const workingArea = createClaudeWorkingArea({
      platform: "linux",
      homeDirectory: home,
      environment: { HOME: home, XDG_CACHE_HOME: join(home, ".cache") },
      fileSystem: {
        closeSync: observedClose,
        fstatSync: observedFstat,
        lstatSync: observedLstat,
        openSync: observedOpen,
        readSync,
      },
    });
    const binding = await workingArea.prepareForLaunch("generation");
    const marker = paths(home).marker;
    const workspaceIdentity = lstatSync(binding.cwd);
    const markerIdentity = lstatSync(marker);
    forcedIdentities.set(binding.cwd, {
      dev: workspaceIdentity.dev,
      ino: workspaceIdentity.ino,
    });
    forcedIdentities.set(marker, { dev: markerIdentity.dev, ino: markerIdentity.ino });
    rmSync(binding.cwd, { recursive: true });
    mkdirSync(binding.cwd, { mode: 0o700 });
    writeFileSync(marker, "a".repeat(64), { mode: 0o600 });

    expect(() => binding.assertCurrent()).toThrowError(ClaudeWorkingAreaError);
  });

  it("keeps the host path out of its recoverable error", async () => {
    const home = testHome();
    const resolved = paths(home);
    mkdirSync(resolved.appRoot, { recursive: true, mode: 0o700 });
    writeFileSync(resolved.workspace, "not a directory");
    const error = await area(home)
      .prepareForLaunch("account")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ClaudeWorkingAreaError);
    expect((error as Error).message).not.toContain(home);
    expect((error as Error).message).not.toMatch(/Documents|Downloads|Full Disk Access/);
  });
});
