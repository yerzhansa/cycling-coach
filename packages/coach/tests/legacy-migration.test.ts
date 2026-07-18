import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_MIGRATION_CONTROL_RELATIVE,
  LEGACY_MIGRATION_NON_TTY_REFUSAL_EXIT_CODE,
  migrateLegacyHomeUnderLock,
  type LegacyMigrationDependencies,
  type LegacyMigrationResult,
} from "../src/legacy-migration.js";

interface EntryView {
  id: string;
  sourceOwner: string;
  sourcePath: string;
  sourceRelativePath: string;
  fileType: string;
  disposition: string;
  reason: string;
  targetRelativePath: string | null;
  sourceSha256: string | null;
  outputSha256: string | null;
  targetAtPlan: string | null;
  targetActualSha256: string | null;
  requiresConfirmation: boolean;
}

interface JournalView {
  manifestDigest: string;
  state: string;
  revision: number;
  history: Array<{ revision: number; state: string; at: string }>;
  manifest: { entries: EntryView[]; dataRoot: string };
  results: { copiedIds: string[]; skipVerifiedIds: string[]; skippedConflictIds: string[] };
  refusal: null | {
    code: string;
    entryIds: string[];
    expectedHashes: Array<string | null>;
    actualHashes: Array<string | null>;
  };
  verification: {
    complete: boolean;
    allMatch: boolean;
    outputs: Array<{ entryId: string; matches: boolean }>;
  };
  completion: string;
  freezePoint: string | null;
}

interface Fixture {
  parent: string;
  source: string;
  target: string;
}

const parents: string[] = [];
let uuidCounter = 0;

afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
  uuidCounter = 0;
  vi.restoreAllMocks();
});

function deterministicUuid(): string {
  uuidCounter += 1;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function dependencies(overrides: LegacyMigrationDependencies = {}): LegacyMigrationDependencies {
  let tick = 0;
  return {
    now: () => new Date(Date.UTC(1998, 6, 18, 12, 0, tick++)),
    randomId: deterministicUuid,
    ...overrides,
  };
}

async function makeFixture(
  config = "llm:\n  provider: anthropic\nunknown: preserved\n",
): Promise<Fixture> {
  const parent = await mkdtemp(join(await realpath(tmpdir()), "legacy-migration-"));
  parents.push(parent);
  const source = join(parent, "legacy");
  const target = join(parent, "new-home");
  await mkdir(source, { mode: 0o700 });
  await write(source, "config.yaml", config);
  return { parent, source, target };
}

async function write(
  root: string,
  path: string,
  value: string | Buffer,
  mode = 0o600,
): Promise<void> {
  const destination = join(root, ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, value, { mode });
  await chmod(destination, mode);
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function seedPayload(fixture: Fixture): Promise<void> {
  await write(
    fixture.source,
    "auth-profiles.json",
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "access",
        refresh: "refresh",
        expires: 946684800000,
      },
    }),
  );
  await write(fixture.source, "memory/MEMORY.md", "durable memory\n");
  await write(fixture.source, "memory/1998-07-18.md", "daily note\n");
  await write(fixture.source, "memory/MEMORY.history.jsonl", '{"memory":1}\n');
  await write(fixture.source, "memory/events.jsonl", '{"event":1}\n');
  await write(fixture.source, "plans/current-plan.json", '{"week":1}\n');
}

function journalPath(fixture: Fixture): string {
  return join(fixture.target, ...LEGACY_MIGRATION_CONTROL_RELATIVE.split("/"), "journal.json");
}

async function journal(fixture: Fixture): Promise<JournalView> {
  return JSON.parse(await readFile(journalPath(fixture), "utf8")) as JournalView;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function snapshotByteTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  if (!(await exists(root))) return hash.update("absent").digest("hex");
  async function walk(directory: string): Promise<void> {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const path = join(directory, name);
      const stat = await lstat(path);
      const rel = relative(root, path).split("/").join("/");
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        hash.update(`${rel}\0directory\0`);
        await walk(path);
      } else if (stat.isSymbolicLink()) {
        hash.update(`${rel}\0symlink\0${await readlink(path)}\0`);
      } else if (stat.isFile()) {
        hash.update(`${rel}\0regular\0`);
        hash.update(await readFile(path));
      } else hash.update(`${rel}\0other\0`);
    }
  }
  await walk(root);
  return hash.digest("hex");
}

async function preserving<T>(roots: string[], operation: () => Promise<T>): Promise<T> {
  const before = await Promise.all(roots.map(snapshotByteTree));
  try {
    return await operation();
  } finally {
    expect(await Promise.all(roots.map(snapshotByteTree))).toEqual(before);
  }
}

function expectRefused(
  result: LegacyMigrationResult,
  reason: string,
  exitCode?: number,
): asserts result is Extract<LegacyMigrationResult, { status: "refused" }> {
  expect(result.status).toBe("refused");
  if (result.status !== "refused") throw new Error("expected refusal");
  expect(result.reason).toBe(reason);
  if (exitCode !== undefined) expect(result.exitCode).toBe(exitCode);
}

async function migrate(
  fixture: Fixture,
  overrides: LegacyMigrationDependencies = {},
): Promise<LegacyMigrationResult> {
  return migrateLegacyHomeUnderLock(
    {
      sourceRoot: fixture.source,
      targetRoot: fixture.target,
      action: { kind: "resume", isTTY: true },
    },
    dependencies(overrides),
  );
}

async function cleanDoneFixture(): Promise<{
  fixture: Fixture;
  result: Extract<LegacyMigrationResult, { status: "done" }>;
}> {
  const fixture = await makeFixture();
  await seedPayload(fixture);
  const result = await migrate(fixture);
  expect(result.status).toBe("done");
  if (result.status !== "done") throw new Error("expected done");
  return { fixture, result };
}

describe("legacy home migration", () => {
  it("clean copy reaches done only after verification", async () => {
    const fixture = await makeFixture();
    await seedPayload(fixture);
    await preserving([fixture.source], async () => {
      const result = await migrate(fixture);
      expect(result).toMatchObject({ status: "done", completion: "complete", exitCode: 0 });
      for (const path of [
        "config/config.yaml",
        "config/auth-profiles.json",
        "memory/MEMORY.md",
        "memory/1998-07-18.md",
        "memory/MEMORY.history.jsonl",
        "memory/events.jsonl",
        "plans/current-plan.json",
      ])
        expect(await exists(join(fixture.target, path))).toBe(true);
      const view = await journal(fixture);
      expect(view.history.map((row) => row.state)).toEqual(
        expect.arrayContaining(["planned", "copying", "verified", "done"]),
      );
      expect(view.verification).toMatchObject({ complete: true, allMatch: true });
      expect(view.freezePoint).toBeTruthy();
    });
  });

  it("done rerun validates cutover without copying", async () => {
    for (const kind of ["clean", "target", "change", "add", "delete"] as const) {
      const { fixture } = await cleanDoneFixture();
      const sourceBefore = await snapshotByteTree(fixture.source);
      const journalBefore = await readFile(journalPath(fixture));
      const targetBefore = await snapshotByteTree(fixture.target);
      let restore: (() => Promise<void>) | undefined;
      if (kind === "target") {
        const path = join(fixture.target, "memory/MEMORY.md");
        await writeFile(path, "tampered");
        restore = async () => writeFile(path, "durable memory\n");
      }
      if (kind === "change") {
        const path = join(fixture.source, "memory/MEMORY.md");
        await writeFile(path, "changed");
        restore = async () => writeFile(path, "durable memory\n");
      }
      if (kind === "add") {
        const path = join(fixture.source, "new.txt");
        await writeFile(path, "new");
        restore = async () => unlink(path);
      }
      if (kind === "delete") {
        const path = join(fixture.source, "memory/events.jsonl");
        await unlink(path);
        restore = async () => writeFile(path, '{"event":1}\n', { mode: 0o600 });
      }
      const result = await migrate(fixture);
      if (kind === "clean")
        expect(result).toMatchObject({ status: "done", copiedIds: [], skipVerifiedIds: [] });
      else if (kind === "target") expectRefused(result, "verification-failed", 3);
      else expectRefused(result, "legacy-mutated-after-cutover", 3);
      expect(await readFile(journalPath(fixture))).toEqual(journalBefore);
      if (kind !== "target") expect(await snapshotByteTree(fixture.target)).toBe(targetBefore);
      await restore?.();
      expect(await snapshotByteTree(fixture.source)).toBe(sourceBefore);
    }
  });

  it("identical target collision is skip-verified", async () => {
    const fixture = await makeFixture();
    await write(fixture.source, "memory/MEMORY.md", "same");
    await privateDirectory(join(fixture.target, "memory"));
    await write(fixture.target, "memory/MEMORY.md", "same");
    await preserving([fixture.source], async () => {
      const result = await migrate(fixture);
      expect(result).toMatchObject({ status: "done", completion: "complete" });
      if (result.status === "done") expect(result.skipVerifiedIds.length).toBeGreaterThan(0);
      expect(await readFile(join(fixture.target, "memory/MEMORY.md"), "utf8")).toBe("same");
    });
  });

  it("different target collision refuses before any payload copy", async () => {
    const fixture = await makeFixture();
    await seedPayload(fixture);
    await privateDirectory(join(fixture.target, "memory"));
    await write(fixture.target, "memory/MEMORY.md", "newer");
    const payloadBefore = await snapshotByteTree(join(fixture.target, "memory"));
    await preserving([fixture.source], async () => {
      const first = await migrate(fixture);
      expectRefused(first, "confirmation-required", 2);
      const second = await migrate(fixture);
      expectRefused(second, "pinned-refusal", 2);
      expect(await snapshotByteTree(join(fixture.target, "memory"))).toBe(payloadBefore);
      expect((await journal(fixture)).state).toBe("planned");
    });
  });

  it("symlinks, cycles, and regular-to-symlink swaps are never followed", async () => {
    const fixture = await makeFixture();
    await write(fixture.source, "memory/MEMORY.md", "safe");
    await write(fixture.parent, "outside", "secret");
    await symlink(join(fixture.parent, "outside"), join(fixture.source, "outside-link"));
    await symlink(fixture.source, join(fixture.source, "cycle"));
    const original = await readFile(join(fixture.source, "memory/MEMORY.md"));
    await preserving([fixture.source], async () => {
      let swapped = false;
      const result = await migrate(fixture, {
        checkpoint: async (context) => {
          if (
            !swapped &&
            context.checkpoint === "before-payload-publication" &&
            context.entryId !== null
          ) {
            const view = await journal(fixture);
            const entry = view.manifest.entries.find(
              (candidate) => candidate.id === context.entryId,
            );
            if (entry?.sourceRelativePath === "memory/MEMORY.md") {
              swapped = true;
              await unlink(entry.sourcePath);
              await symlink(join(fixture.parent, "outside"), entry.sourcePath);
            }
          }
        },
      });
      expectRefused(result, "source-drift", 3);
      expect(await exists(join(fixture.target, "memory/MEMORY.md"))).toBe(false);
      if (swapped) {
        await unlink(join(fixture.source, "memory/MEMORY.md"));
        await writeFile(join(fixture.source, "memory/MEMORY.md"), original, { mode: 0o600 });
      }
    });
  });

  it("data-root ownership is deterministic", async () => {
    for (const kind of ["equal", "external", "child", "parent"] as const) {
      const fixture = await makeFixture();
      let dataRoot = fixture.source;
      if (kind === "external") dataRoot = join(fixture.parent, "data");
      if (kind === "child") dataRoot = join(fixture.source, "data-home");
      if (kind === "parent") {
        dataRoot = join(fixture.parent, "data-parent");
        fixture.source = join(dataRoot, "legacy");
        await mkdir(fixture.source, { recursive: true });
      }
      await privateDirectory(dataRoot);
      await write(dataRoot, "memory/MEMORY.md", `${kind}-authoritative`);
      await write(
        fixture.source,
        "config.yaml",
        `data_dir: ${dataRoot}\nllm:\n  provider: anthropic\n`,
      );
      if (dataRoot !== fixture.source) await write(fixture.source, "memory/MEMORY.md", "shadowed");
      await preserving([...new Set([fixture.source, dataRoot])], async () => {
        const result = await migrate(fixture);
        expect(result.status).toBe("done");
        expect(await readFile(join(fixture.target, "memory/MEMORY.md"), "utf8")).toBe(
          `${kind}-authoritative`,
        );
        const view = await journal(fixture);
        expect(new Set(view.manifest.entries.map((entry) => entry.sourcePath)).size).toBe(
          view.manifest.entries.length,
        );
        const memory = view.manifest.entries.find(
          (entry) => entry.sourcePath === join(dataRoot, "memory/MEMORY.md"),
        );
        expect(memory?.sourceOwner).toBe(kind === "equal" ? "legacy-root" : "data-root");
      });
    }
  });

  it("mid-copy crash after two payload checkpoints resumes", async () => {
    const fixture = await makeFixture();
    await seedPayload(fixture);
    let count = 0;
    await preserving([fixture.source], async () => {
      await expect(
        migrate(fixture, {
          checkpoint: (context) => {
            if (context.checkpoint === "after-payload-checkpoint" && ++count === 2)
              throw new Error("crash");
          },
        }),
      ).rejects.toThrow("crash");
      expect((await journal(fixture)).state).toBe("copying");
      const result = await migrate(fixture);
      expect(result.status).toBe("done");
      if (result.status === "done") expect(result.skipVerifiedIds).toHaveLength(2);
    });
  });

  it("crash around initial journal publication resumes", async () => {
    for (const checkpoint of ["before-journal-rename", "after-journal-rename"] as const) {
      const fixture = await makeFixture();
      await write(fixture.source, "memory/MEMORY.md", "memory");
      let injected = false;
      await preserving([fixture.source], async () => {
        await expect(
          migrate(fixture, {
            checkpoint: (context) => {
              if (!injected && context.checkpoint === checkpoint) {
                injected = true;
                throw new Error(checkpoint);
              }
            },
          }),
        ).rejects.toThrow(checkpoint);
        expect(await exists(journalPath(fixture))).toBe(checkpoint === "after-journal-rename");
        expect((await migrate(fixture)).status).toBe("done");
      });
    }
  });

  it("config transform strips only telegram token, rewrites data_dir, and carries OAuth", async () => {
    const fixture = await makeFixture(
      "# comment\nllm:\n  provider: openai-codex\n  auth_profile: athlete\ntelegram:\n  bot_token: !secret token-ref\n  chat_id: 42\nintervals:\n  api_key: !secret intervals-ref\nfuture: yes\n",
    );
    const profiles = {
      athlete: {
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: 1,
        accountId: "id",
        email: "a@example.test",
      },
    };
    await write(fixture.source, "auth-profiles.json", JSON.stringify(profiles));
    await preserving([fixture.source], async () => {
      expect((await migrate(fixture)).status).toBe("done");
      const output = await readFile(join(fixture.target, "config/config.yaml"), "utf8");
      expect(output).not.toContain("bot_token");
      expect(output).toContain("chat_id: 42");
      expect(output).toContain("intervals-ref");
      expect(output).toContain("future: yes");
      expect(output).toContain(`data_dir: ${fixture.target}`);
      expect(await readFile(join(fixture.target, "config/auth-profiles.json"), "utf8")).toBe(
        JSON.stringify(profiles),
      );
    });
  });

  it("confirmed immutable conflict plan completes partial without copying conflicts", async () => {
    const fixture = await makeFixture();
    await seedPayload(fixture);
    await privateDirectory(join(fixture.target, "memory"));
    await write(fixture.target, "memory/MEMORY.md", "keep");
    await preserving([fixture.source], async () => {
      const planned = await migrate(fixture);
      expectRefused(planned, "confirmation-required");
      const result = await migrateLegacyHomeUnderLock(
        {
          sourceRoot: fixture.source,
          targetRoot: fixture.target,
          action: { kind: "confirm", manifestDigest: planned.manifestDigest! },
        },
        dependencies(),
      );
      expect(result).toMatchObject({ status: "done", completion: "partial" });
      expect(await readFile(join(fixture.target, "memory/MEMORY.md"), "utf8")).toBe("keep");
      expect((await journal(fixture)).results.skippedConflictIds).toEqual(planned.conflictIds);
    });
  });

  it("non-TTY conflict refusal uses exit 2 and never reads stdin", async () => {
    const fixture = await makeFixture();
    await write(fixture.source, "memory/MEMORY.md", "old");
    await privateDirectory(join(fixture.target, "memory"));
    await write(fixture.target, "memory/MEMORY.md", "new");
    const stdin = vi.spyOn(process.stdin, "read");
    const result = await migrateLegacyHomeUnderLock(
      {
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        action: { kind: "resume", isTTY: false },
      },
      dependencies(),
    );
    expectRefused(result, "confirmation-required", LEGACY_MIGRATION_NON_TTY_REFUSAL_EXIT_CODE);
    expect(stdin).not.toHaveBeenCalled();
  });

  it("discard archives without clobber and recovers each boundary", async () => {
    for (const kind of [
      "normal",
      "identical",
      "different",
      "after-link",
      "after-unlink",
    ] as const) {
      const fixture = await makeFixture();
      await write(fixture.source, "memory/MEMORY.md", "old");
      await privateDirectory(join(fixture.target, "memory"));
      await write(fixture.target, "memory/MEMORY.md", "new");
      const planned = await migrate(fixture);
      expectRefused(planned, "confirmation-required");
      const archive = join(
        dirname(journalPath(fixture)),
        `journal.discarded.${planned.manifestDigest}.json`,
      );
      if (kind === "identical")
        await writeFile(archive, await readFile(journalPath(fixture)), { mode: 0o600 });
      if (kind === "different") await writeFile(archive, "different", { mode: 0o600 });
      const checkpoint =
        kind === "after-link"
          ? "after-discard-archive-link"
          : kind === "after-unlink"
            ? "after-discard-journal-unlink"
            : null;
      const action = migrateLegacyHomeUnderLock(
        {
          sourceRoot: fixture.source,
          targetRoot: fixture.target,
          action: { kind: "discard", manifestDigest: planned.manifestDigest! },
        },
        dependencies({
          checkpoint: (context) => {
            if (context.checkpoint === checkpoint) throw new Error(kind);
          },
        }),
      );
      if (kind === "different") {
        const result = await action;
        expectRefused(result, "invalid-action", 2);
        expect(await exists(journalPath(fixture))).toBe(true);
      } else if (checkpoint !== null) {
        await expect(action).rejects.toThrow(kind);
        expect(await exists(archive)).toBe(true);
        expect(await exists(journalPath(fixture))).toBe(kind === "after-link");
      } else {
        const result = await action;
        expect(result.status).toBe("discarded");
        expect(await exists(archive)).toBe(true);
        expect(await exists(journalPath(fixture))).toBe(false);
      }
    }
  });

  it("replan requires a matching discarded digest and observes current bytes only after explicit replan", async () => {
    const fixture = await makeFixture();
    await write(fixture.source, "memory/MEMORY.md", "old");
    await privateDirectory(join(fixture.target, "memory"));
    await write(fixture.target, "memory/MEMORY.md", "new");
    const planned = await migrate(fixture);
    expectRefused(planned, "confirmation-required");
    await unlink(join(fixture.target, "memory/MEMORY.md"));
    expectRefused(await migrate(fixture), "pinned-refusal");
    const discarded = await migrateLegacyHomeUnderLock(
      {
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        action: { kind: "discard", manifestDigest: planned.manifestDigest! },
      },
      dependencies(),
    );
    expect(discarded.status).toBe("discarded");
    expectRefused(
      await migrateLegacyHomeUnderLock(
        {
          sourceRoot: fixture.source,
          targetRoot: fixture.target,
          action: { kind: "replan", discardedManifestDigest: "0".repeat(64), isTTY: true },
        },
        dependencies(),
      ),
      "manifest-mismatch",
    );
    const result = await migrateLegacyHomeUnderLock(
      {
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        action: { kind: "replan", discardedManifestDigest: planned.manifestDigest!, isTTY: true },
      },
      dependencies(),
    );
    expect(result.status).toBe("done");
  });

  it("fresh journal temps and stale-temp cleanup survive abandoned revision temps", async () => {
    const fixture = await makeFixture();
    await privateDirectory(dirname(journalPath(fixture)));
    await writeFile(
      join(
        dirname(journalPath(fixture)),
        "journal.json.tmp.123.00000000-0000-4000-8000-000000000999",
      ),
      "stale",
      { mode: 0o600 },
    );
    expect((await migrate(fixture)).status).toBe("done");
    expect(
      (await readdir(dirname(journalPath(fixture)))).some((name) => name.includes("000000000999")),
    ).toBe(false);
  });

  it("payload stale-temp cleanup removes only exact migration-temp names", async () => {
    const fixture = await makeFixture();
    await write(fixture.source, "memory/MEMORY.md", "memory");
    await privateDirectory(join(fixture.target, "memory"));
    await write(
      fixture.target,
      "memory/.MEMORY.md.legacy-migration.tmp.123.00000000-0000-4000-8000-000000000999",
      "stale",
    );
    await write(fixture.target, "memory/.MEMORY.md.unrelated.tmp", "keep");
    expect((await migrate(fixture)).status).toBe("done");
    expect(
      await exists(
        join(
          fixture.target,
          "memory/.MEMORY.md.legacy-migration.tmp.123.00000000-0000-4000-8000-000000000999",
        ),
      ),
    ).toBe(false);
    expect(await exists(join(fixture.target, "memory/.MEMORY.md.unrelated.tmp"))).toBe(true);
  });

  it("source drift is checked before publication and before verified", async () => {
    for (const stage of ["publication", "final"] as const) {
      const fixture = await makeFixture();
      await write(fixture.source, "memory/MEMORY.md", "original");
      const original = await readFile(join(fixture.source, "memory/MEMORY.md"));
      let changed = false;
      const result = await migrate(fixture, {
        checkpoint: async (context) => {
          if (
            !changed &&
            ((stage === "publication" && context.checkpoint === "before-payload-publication") ||
              (stage === "final" &&
                context.checkpoint === "after-payload-checkpoint" &&
                (await exists(join(fixture.target, "memory/MEMORY.md")))))
          ) {
            changed = true;
            await writeFile(join(fixture.source, "memory/MEMORY.md"), "changed");
          }
        },
      });
      expectRefused(result, "source-drift", 3);
      expect(["verified", "done"]).not.toContain((await journal(fixture)).state);
      await writeFile(join(fixture.source, "memory/MEMORY.md"), original, { mode: 0o600 });
    }
  });

  it("hard-link unsupported refuses with no-clobber-unavailable", async () => {
    const fixture = await makeFixture();
    await write(fixture.source, "memory/MEMORY.md", "memory");
    const error = Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
    const result = await migrate(fixture, {
      link: async () => {
        throw error;
      },
    });
    expectRefused(result, "no-clobber-unavailable", 3);
    expect(await exists(join(fixture.target, "memory/MEMORY.md"))).toBe(false);
  });

  it("target path and identity cannot escape", async () => {
    for (const kind of [
      "root-link",
      "config-link",
      "payload-link",
      "physical-alias",
      "absent-alias",
    ] as const) {
      const fixture = await makeFixture();
      await write(fixture.source, "memory/MEMORY.md", "memory");
      const outside = join(fixture.parent, "outside");
      await privateDirectory(outside);
      if (kind === "root-link") await symlink(outside, fixture.target);
      if (kind === "config-link") {
        await privateDirectory(fixture.target);
        await symlink(outside, join(fixture.target, "config"));
      }
      if (kind === "payload-link") {
        await privateDirectory(fixture.target);
        await symlink(outside, join(fixture.target, "memory"));
      }
      if (kind === "physical-alias") fixture.target = await realpath(fixture.source);
      if (kind === "absent-alias") fixture.target = join(fixture.source, "future", "home");
      const result = await migrate(fixture);
      expectRefused(
        result,
        kind.includes("alias") ? "source-target-overlap" : "target-path-unsafe",
        3,
      );
      expect(await readdir(outside)).toEqual([]);
    }
  });

  it("control namespace is excluded from payload conflicts and destination layout is exact", async () => {
    const fixture = await makeFixture();
    await write(fixture.source, "memory/MEMORY.md", "memory");
    await privateDirectory(dirname(journalPath(fixture)));
    await writeFile(join(dirname(journalPath(fixture)), "unrelated-control"), "control", {
      mode: 0o600,
    });
    expect((await migrate(fixture)).status).toBe("done");
    expect(await readFile(join(dirname(journalPath(fixture)), "unrelated-control"), "utf8")).toBe(
      "control",
    );
    expect((await readdir(fixture.target)).sort()).toEqual(["config", "memory"]);
  });

  it("disposition inventory covers every excluded class", async () => {
    const fixture = await makeFixture();
    const cases: Array<[string, string, string]> = [
      ["allowed-senders.json", "defer", "telegram-guided-import"],
      [".allowed-senders.lock", "skip", "transient-allowlist-lock"],
      ["sessions/telegram:1.jsonl", "defer", "telegram-channel-state"],
      ["sessions/cli.jsonl", "skip", "fresh-cli-session"],
      ["data/cache.json", "skip", "re-derivable"],
      ["logs/run.log", "skip", "diagnostic"],
      ["usage-ledger.jsonl.old", "skip", "diagnostic"],
      ["instance-id", "skip", "machine-local"],
      ["last-notified-version", "skip", "machine-local"],
      ["last-run.json", "skip", "machine-local"],
      ["store/db", "skip", "reserved-namespace"],
      ["archive/old", "skip", "reserved-namespace"],
      ["config/old", "skip", "reserved-namespace"],
      ["unknown.txt", "skip", "unrecognized"],
    ];
    for (const [path] of cases) await write(fixture.source, path, path);
    await symlink("unknown.txt", join(fixture.source, "unknown-link"));
    expect((await migrate(fixture)).status).toBe("done");
    const view = await journal(fixture);
    for (const [path, disposition, reason] of cases)
      expect(
        view.manifest.entries.find((entry) => entry.sourceRelativePath === path),
      ).toMatchObject({ disposition, reason, targetRelativePath: null });
    expect(
      view.manifest.entries.find((entry) => entry.sourceRelativePath === "unknown-link"),
    ).toMatchObject({ fileType: "symlink", disposition: "skip", reason: "symlink" });
  });

  it("raw roots reject before I/O", async () => {
    const fixture = await makeFixture();
    const before = await snapshotByteTree(fixture.parent);
    for (const root of ["", ".", "relative/child"]) {
      for (const side of ["source", "target"] as const) {
        const result = await migrateLegacyHomeUnderLock({
          sourceRoot: side === "source" ? root : fixture.source,
          targetRoot: side === "target" ? root : fixture.target,
          action: { kind: "resume", isTTY: false },
        });
        expect(result).toMatchObject({
          status: "refused",
          reason: "invalid-action",
          exitCode: 2,
          manifestDigest: null,
          conflictIds: [],
        });
      }
    }
    expect(await snapshotByteTree(fixture.parent)).toBe(before);
  });

  it("source and data roots cannot overlap target", async () => {
    for (const kind of [
      "equal",
      "parent",
      "child",
      "data-equal",
      "data-parent",
      "data-child",
    ] as const) {
      const fixture = await makeFixture();
      if (kind === "equal") fixture.target = fixture.source;
      if (kind === "parent") fixture.target = fixture.parent;
      if (kind === "child") fixture.target = join(fixture.source, "new");
      if (kind.startsWith("data")) {
        const data =
          kind === "data-equal"
            ? fixture.target
            : kind === "data-parent"
              ? fixture.parent
              : join(fixture.target, "data");
        await write(
          fixture.source,
          "config.yaml",
          `data_dir: ${data}\nllm:\n  provider: anthropic\n`,
        );
      }
      const result = await migrate(fixture);
      expectRefused(result, "source-target-overlap", 3);
    }
  });

  it("invalid source config is pre-plan", async () => {
    const variants: Array<string | null> = [
      null,
      "bad: [",
      "a: 1\na: 2\n",
      "- list\n",
      "*missing\n",
    ];
    for (const value of variants) {
      const fixture = await makeFixture();
      if (value === null) await unlink(join(fixture.source, "config.yaml"));
      else await write(fixture.source, "config.yaml", value);
      const result = await migrate(fixture);
      expectRefused(result, "invalid-source-config", 4);
      expect(await exists(dirname(journalPath(fixture)))).toBe(false);
    }
    const fixture = await makeFixture();
    await rm(fixture.source, { recursive: true });
    expect((await migrate(fixture)).status).toBe("not-needed");
  });

  it("unsupported data_dir is pre-plan", async () => {
    for (const value of ["~/home", "relative", "", "42"] as const) {
      const fixture = await makeFixture(
        `data_dir: ${value === "" ? '""' : value}\nllm:\n  provider: anthropic\n`,
      );
      const result = await migrate(fixture);
      expectRefused(result, "unsupported-data-dir", 4);
      expect(await exists(dirname(journalPath(fixture)))).toBe(false);
    }
    const fixture = await makeFixture();
    const actual = join(fixture.parent, "actual-data");
    await privateDirectory(actual);
    const alias = join(fixture.parent, "data-alias");
    await symlink(actual, alias);
    await write(fixture.source, "config.yaml", `data_dir: ${alias}\n`);
    expectRefused(await migrate(fixture), "unsupported-data-dir", 4);
  });

  it("OAuth continuity validation is fail-closed", async () => {
    const invalid = [
      "bad",
      "[]",
      '{"p":{}}',
      '{"p":{"type":"oauth","access":"a","refresh":"r","expires":1,"extra":1}}',
      '{"p":{"type":"oauth","access":"a","refresh":"r","expires":1e400}}',
    ];
    for (const value of invalid) {
      const fixture = await makeFixture("llm:\n  provider: openai-codex\n  auth_profile: p\n");
      await write(fixture.source, "auth-profiles.json", value);
      expectRefused(await migrate(fixture), "invalid-source-config", 4);
    }
    const missing = await makeFixture("llm:\n  provider: openai-codex\n");
    await write(missing.source, "auth-profiles.json", "{}");
    expectRefused(await migrate(missing), "invalid-source-config", 4);
    const valid = await makeFixture("llm:\n  provider: openai-codex\n  auth_profile: p\n");
    await write(
      valid.source,
      "auth-profiles.json",
      '{"p":{"type":"oauth","access":"a","refresh":"r","expires":1,"accountId":"id","email":"e"}}',
    );
    expect((await migrate(valid)).status).toBe("done");
  });

  it("credential-layout refusal pins and blocks publication", async () => {
    for (const kind of ["regular", "symlink"] as const) {
      const fixture = await makeFixture();
      await write(fixture.source, "memory/MEMORY.md", "memory");
      if (kind === "regular") await write(fixture.source, "auth/codex/token", "token");
      else {
        await privateDirectory(join(fixture.source, "auth"));
        await symlink(join(fixture.parent, "outside"), join(fixture.source, "auth/codex"));
      }
      const first = await migrate(fixture);
      expectRefused(first, "unsupported-credential-layout", 4);
      expect(await exists(join(fixture.target, "memory/MEMORY.md"))).toBe(false);
      expectRefused(await migrate(fixture), "pinned-refusal", 2);
      expectRefused(
        await migrateLegacyHomeUnderLock(
          {
            sourceRoot: fixture.source,
            targetRoot: fixture.target,
            action: { kind: "confirm", manifestDigest: first.manifestDigest! },
          },
          dependencies(),
        ),
        "invalid-action",
        2,
      );
    }
  });

  it("actions are state constrained", async () => {
    const fixture = await makeFixture();
    expectRefused(
      await migrateLegacyHomeUnderLock({
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        action: { kind: "confirm", manifestDigest: "0".repeat(64) },
      }),
      "invalid-action",
    );
    expectRefused(
      await migrateLegacyHomeUnderLock({
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        action: { kind: "discard", manifestDigest: "0".repeat(64) },
      }),
      "invalid-action",
    );
    const done = await migrate(fixture);
    expect(done.status).toBe("done");
    const digest = done.manifestDigest!;
    expectRefused(
      await migrateLegacyHomeUnderLock({
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        action: { kind: "confirm", manifestDigest: digest },
      }),
      "invalid-action",
    );
    expectRefused(
      await migrateLegacyHomeUnderLock({
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        action: { kind: "discard", manifestDigest: digest },
      }),
      "invalid-action",
    );
    expectRefused(
      await migrateLegacyHomeUnderLock({
        sourceRoot: fixture.source,
        targetRoot: fixture.target,
        action: { kind: "replan", discardedManifestDigest: digest, isTTY: true },
      }),
      "invalid-action",
    );
  });

  it("resume preserves immutable plan-time target fields", async () => {
    const fixture = await makeFixture();
    await write(fixture.source, "memory/MEMORY.md", "memory");
    let crashed = false;
    await expect(
      migrate(fixture, {
        checkpoint: (context) => {
          if (!crashed && context.checkpoint === "after-payload-checkpoint") {
            crashed = true;
            throw new Error("crash");
          }
        },
      }),
    ).rejects.toThrow("crash");
    const before = await journal(fixture);
    const result = await migrate(fixture);
    expect(result.status).toBe("done");
    const after = await journal(fixture);
    expect(after.manifestDigest).toBe(before.manifestDigest);
    expect(after.manifest.entries.map((entry) => entry.id)).toEqual(
      before.manifest.entries.map((entry) => entry.id),
    );
  });

  it("journal validation is strict and ordered before source absence", async () => {
    for (const kind of ["malformed", "unknown", "constant", "digest", "root", "mode"] as const) {
      const fixture = await makeFixture();
      await privateDirectory(dirname(journalPath(fixture)));
      let value = "{";
      if (kind !== "malformed") {
        const clean = await cleanDoneFixture();
        value = await readFile(journalPath(clean.fixture), "utf8");
        const parsed = JSON.parse(value) as Record<string, unknown>;
        if (kind === "unknown") parsed.extra = true;
        if (kind === "constant") parsed.schemaVersion = 2;
        if (kind === "digest") parsed.manifestDigest = "0".repeat(64);
        if (kind === "root") parsed.sourceRoot = fixture.source;
        value = JSON.stringify(parsed);
      }
      await writeFile(journalPath(fixture), value, { mode: kind === "mode" ? 0o644 : 0o600 });
      const result = await migrate(fixture);
      expectRefused(result, kind === "mode" ? "target-path-unsafe" : "manifest-mismatch");
    }
    const { fixture } = await cleanDoneFixture();
    await rm(fixture.source, { recursive: true });
    expectRefused(await migrate(fixture), "legacy-mutated-after-cutover", 3);
  });

  it("post-preflight target race and verification failure are pinned", async () => {
    for (const kind of ["race", "verify"] as const) {
      const fixture = await makeFixture();
      await write(fixture.source, "memory/MEMORY.md", "memory");
      let acted = false;
      const result = await migrate(fixture, {
        checkpoint: async (context) => {
          if (acted) return;
          if (kind === "race" && context.checkpoint === "before-payload-publication") {
            acted = true;
            await write(fixture.target, "memory/MEMORY.md", "racer");
          }
          if (
            kind === "verify" &&
            context.checkpoint === "after-payload-checkpoint" &&
            (await exists(join(fixture.target, "memory/MEMORY.md")))
          ) {
            acted = true;
            await writeFile(join(fixture.target, "memory/MEMORY.md"), "tamper");
          }
        },
      });
      expectRefused(result, kind === "race" ? "target-conflict" : "verification-failed", 3);
      expect(["verified", "done"]).not.toContain((await journal(fixture)).state);
    }
  });

  it("result arrays distinguish invocation from cumulative journal state", async () => {
    const fixture = await makeFixture();
    await seedPayload(fixture);
    let count = 0;
    await expect(
      migrate(fixture, {
        checkpoint: (context) => {
          if (context.checkpoint === "after-payload-checkpoint" && ++count === 2)
            throw new Error("crash");
        },
      }),
    ).rejects.toThrow("crash");
    const resumed = await migrate(fixture);
    expect(resumed.status).toBe("done");
    const cumulative = await journal(fixture);
    expect(cumulative.results.copiedIds.length).toBeGreaterThan(0);
    expect(cumulative.results.skipVerifiedIds.length).toBe(2);
    const rerun = await migrate(fixture);
    expect(rerun).toMatchObject({ status: "done", copiedIds: [], skipVerifiedIds: [] });
  });

  it("control and file modes are not broader than private", async () => {
    const { fixture } = await cleanDoneFixture();
    for (const path of [
      fixture.target,
      join(fixture.target, "config"),
      join(fixture.target, "memory"),
      dirname(journalPath(fixture)),
    ])
      expect((await lstat(path)).mode & 0o077).toBe(0);
    for (const path of [
      journalPath(fixture),
      join(fixture.target, "config/config.yaml"),
      join(fixture.target, "memory/MEMORY.md"),
    ])
      expect((await lstat(path)).mode & 0o177).toBe(0);
    const unsafe = await makeFixture();
    await privateDirectory(dirname(journalPath(unsafe)));
    await chmod(dirname(journalPath(unsafe)), 0o755);
    expectRefused(await migrate(unsafe), "target-path-unsafe", 3);
    expect((await lstat(dirname(journalPath(unsafe)))).mode & 0o777).toBe(0o755);
  });

  it("invalid random ids never become paths", async () => {
    for (const id of ["invalid", "../../escape"]) {
      const fixture = await makeFixture();
      await expect(migrate(fixture, { randomId: () => id })).rejects.toThrow(
        new TypeError("randomId must return an RFC 4122 UUID"),
      );
      expect(await exists(join(fixture.parent, "escape"))).toBe(false);
    }
    const fixture = await makeFixture();
    await privateDirectory(dirname(journalPath(fixture)));
    const collision = "00000000-0000-4000-8000-000000000001";
    await writeFile(
      join(dirname(journalPath(fixture)), `journal.json.tmp.${process.pid}.${collision}`),
      "collision",
      { mode: 0o600 },
    );
    let calls = 0;
    const result = await migrate(fixture, {
      randomId: () => (calls++ === 0 ? collision : deterministicUuid()),
    });
    expect(result.status).toBe("done");
  });
});
