import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDesktopUsagePingStateStore,
  DESKTOP_USAGE_PING_INTERVAL_MS,
  DESKTOP_USAGE_PING_STATE_DIRECTORY_MODE,
  DESKTOP_USAGE_PING_STATE_FILE_MODE,
  DESKTOP_USAGE_PING_STATE_FILE_NAME,
} from "../src/main/desktop-usage-ping-state.js";

const FIRST_INSTANCE_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_INSTANCE_ID = "20000000-0000-4000-9000-000000000002";
const UPPERCASE_INSTANCE_ID = "ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF";
const temporaryRoots: string[] = [];
const posixIt = it.skipIf(process.platform === "win32");

async function temporaryStateRoot(): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "desktop-usage-ping-state-"));
  temporaryRoots.push(temporaryRoot);
  return join(temporaryRoot, "desktop-preferences-v1");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("desktop usage ping state", () => {
  it("persists one installation identifier and a daily claim across restarts", async () => {
    const root = await temporaryStateRoot();
    const target = join(root, DESKTOP_USAGE_PING_STATE_FILE_NAME);
    const firstProcess = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => FIRST_INSTANCE_ID,
    });

    await expect(firstProcess.claimAttempt(1_000)).resolves.toEqual({
      status: "claimed",
      instanceId: FIRST_INSTANCE_ID,
    });
    await expect(readFile(target, "utf8")).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        instanceId: FIRST_INSTANCE_ID,
        lastAttemptAt: 1_000,
      })}\n`,
    );
    if (process.platform !== "win32") {
      expect((await lstat(root)).mode & 0o777).toBe(DESKTOP_USAGE_PING_STATE_DIRECTORY_MODE);
      expect((await lstat(target)).mode & 0o777).toBe(DESKTOP_USAGE_PING_STATE_FILE_MODE);
    }

    const restartedProcess = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => SECOND_INSTANCE_ID,
    });
    await expect(restartedProcess.claimAttempt(1_001)).resolves.toEqual({
      status: "deferred",
      retryAfterMs: DESKTOP_USAGE_PING_INTERVAL_MS - 1,
    });
    await expect(
      restartedProcess.claimAttempt(1_000 + DESKTOP_USAGE_PING_INTERVAL_MS),
    ).resolves.toEqual({ status: "claimed", instanceId: FIRST_INSTANCE_ID });
  });

  it("serializes concurrent claims so only one attempt is accepted", async () => {
    const root = await temporaryStateRoot();
    const state = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => FIRST_INSTANCE_ID,
    });

    const claims = await Promise.all([state.claimAttempt(10_000), state.claimAttempt(10_000)]);

    expect(claims).toEqual([
      { status: "claimed", instanceId: FIRST_INSTANCE_ID },
      { status: "deferred", retryAfterMs: DESKTOP_USAGE_PING_INTERVAL_MS },
    ]);
  });

  it("replaces corrupt state durably before returning a new identifier", async () => {
    const root = await temporaryStateRoot();
    const target = join(root, DESKTOP_USAGE_PING_STATE_FILE_NAME);
    const initial = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => FIRST_INSTANCE_ID,
    });
    await initial.claimAttempt(1_000);
    await writeFile(target, "not-json\n");
    await chmod(target, DESKTOP_USAGE_PING_STATE_FILE_MODE);

    const recovered = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => SECOND_INSTANCE_ID,
    });
    await expect(recovered.claimAttempt(2_000)).resolves.toEqual({
      status: "claimed",
      instanceId: SECOND_INSTANCE_ID,
    });
    await expect(readFile(target, "utf8")).resolves.toBe(
      `${JSON.stringify({
        schemaVersion: 1,
        instanceId: SECOND_INSTANCE_ID,
        lastAttemptAt: 2_000,
      })}\n`,
    );
  });

  it("never returns an ephemeral identifier when persistence is uncertain", async () => {
    const root = await temporaryStateRoot();
    await mkdir(root, { mode: DESKTOP_USAGE_PING_STATE_DIRECTORY_MODE });
    await chmod(root, DESKTOP_USAGE_PING_STATE_DIRECTORY_MODE);
    const state = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => FIRST_INSTANCE_ID,
      syncDirectory: async () => {
        throw new Error("synthetic directory sync failure");
      },
    });

    await expect(state.claimAttempt(1_000)).resolves.toEqual({ status: "unavailable" });
  });

  it("waits a full interval when the stored wall clock is in the future", async () => {
    const root = await temporaryStateRoot();
    const state = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => FIRST_INSTANCE_ID,
    });
    await state.claimAttempt(10_000);

    await expect(state.claimAttempt(9_999)).resolves.toEqual({
      status: "deferred",
      retryAfterMs: DESKTOP_USAGE_PING_INTERVAL_MS,
    });
  });

  it("refuses invalid clocks and generated identifiers without writing state", async () => {
    const root = await temporaryStateRoot();
    const state = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => "not-a-uuid",
    });

    await expect(state.claimAttempt(Number.NaN)).resolves.toEqual({ status: "unavailable" });
    await expect(state.claimAttempt(1_000)).resolves.toEqual({ status: "unavailable" });
    await expect(
      readFile(join(root, DESKTOP_USAGE_PING_STATE_FILE_NAME), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a non-canonical uppercase installation identifier", async () => {
    const root = await temporaryStateRoot();
    const state = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => UPPERCASE_INSTANCE_ID,
    });

    await expect(state.claimAttempt(1_000)).resolves.toEqual({ status: "unavailable" });
    await expect(
      readFile(join(root, DESKTOP_USAGE_PING_STATE_FILE_NAME), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  posixIt("recovers oversized state only through a bounded durable replacement", async () => {
    const root = await temporaryStateRoot();
    const target = join(root, DESKTOP_USAGE_PING_STATE_FILE_NAME);
    await mkdir(root, { mode: DESKTOP_USAGE_PING_STATE_DIRECTORY_MODE });
    await chmod(root, DESKTOP_USAGE_PING_STATE_DIRECTORY_MODE);
    await writeFile(target, "x".repeat(257), { mode: DESKTOP_USAGE_PING_STATE_FILE_MODE });
    await chmod(target, DESKTOP_USAGE_PING_STATE_FILE_MODE);
    const state = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => FIRST_INSTANCE_ID,
    });

    await expect(state.claimAttempt(1_000)).resolves.toEqual({
      status: "claimed",
      instanceId: FIRST_INSTANCE_ID,
    });
    expect((await readFile(target)).byteLength).toBeLessThanOrEqual(256);
  });

  posixIt("refuses unsafe file permissions and symbolic links", async () => {
    const root = await temporaryStateRoot();
    const target = join(root, DESKTOP_USAGE_PING_STATE_FILE_NAME);
    const initial = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => FIRST_INSTANCE_ID,
    });
    await initial.claimAttempt(1_000);
    const originalContents = await readFile(target, "utf8");
    await chmod(target, 0o644);

    const unsafePermissions = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => SECOND_INSTANCE_ID,
    });
    await expect(
      unsafePermissions.claimAttempt(1_000 + DESKTOP_USAGE_PING_INTERVAL_MS),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(readFile(target, "utf8")).resolves.toBe(originalContents);

    const linked = join(root, "linked-desktop-usage-ping.json");
    await rm(target);
    await writeFile(linked, originalContents, { mode: DESKTOP_USAGE_PING_STATE_FILE_MODE });
    await chmod(linked, DESKTOP_USAGE_PING_STATE_FILE_MODE);
    await symlink(linked, target);
    const unsafeLink = createDesktopUsagePingStateStore({
      root,
      createInstanceId: () => SECOND_INSTANCE_ID,
    });

    await expect(unsafeLink.claimAttempt(1_000 + DESKTOP_USAGE_PING_INTERVAL_MS)).resolves.toEqual({
      status: "unavailable",
    });
    expect((await lstat(target)).isSymbolicLink()).toBe(true);
    await expect(readFile(linked, "utf8")).resolves.toBe(originalContents);
  });

  it("uses the Windows private-file policy without requiring directory sync", async () => {
    const root = await temporaryStateRoot();
    const createWindowsState = () =>
      createDesktopUsagePingStateStore({
        root,
        platform: "win32",
        createInstanceId: () => FIRST_INSTANCE_ID,
        syncDirectory: async () => {
          throw new Error("Windows directory sync must remain unavailable");
        },
      });

    await expect(createWindowsState().claimAttempt(1_000)).resolves.toEqual({
      status: "claimed",
      instanceId: FIRST_INSTANCE_ID,
    });
    const target = join(root, DESKTOP_USAGE_PING_STATE_FILE_NAME);
    await chmod(root, 0o777);
    await chmod(target, 0o666);

    await expect(createWindowsState().claimAttempt(1_001)).resolves.toEqual({
      status: "deferred",
      retryAfterMs: DESKTOP_USAGE_PING_INTERVAL_MS - 1,
    });
  });
});
