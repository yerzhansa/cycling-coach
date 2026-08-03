import { describe, expect, it, vi } from "vitest";
import { TelegramControlSnapshotSchema } from "@enduragent/coach-contract";
import {
  createDesktopTelegramController,
  type DesktopTelegramControllerDependencies,
  type DesktopTelegramRuntime,
  type DesktopTelegramRuntimeFactoryInput,
} from "../src/desktop-telegram-controller.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(options: { readonly primary?: boolean } = {}) {
  const trace: string[] = [];
  const inputs: DesktopTelegramRuntimeFactoryInput[] = [];
  const starts: Deferred<void>[] = [];
  const runtimes: DesktopTelegramRuntime[] = [];
  let now = Date.parse("1998-06-01T12:00:00.000Z");
  const scheduled: {
    readonly callback: () => void;
    readonly dueAt: number;
    readonly handle: ReturnType<typeof setTimeout>;
    canceled: boolean;
  }[] = [];
  let senders: { senderId: string; role: "primary" | "additional"; addedAt?: string }[] =
    options.primary
      ? [{ senderId: "12345", role: "primary", addedAt: "1998-06-01T00:00:00.000Z" }]
      : [];
  const createRuntime = vi.fn((input: DesktopTelegramRuntimeFactoryInput) => {
    inputs.push(input);
    const start = deferred<void>();
    starts.push(start);
    const runtime: DesktopTelegramRuntime = {
      start: vi.fn(() => {
        trace.push(`start:${input.token}`);
        return start.promise;
      }),
      stop: vi.fn(async () => {
        trace.push(`stop:${input.token}`);
      }),
      drainPending: vi.fn(async () => {
        trace.push(`drain:${input.token}`);
      }),
    };
    runtimes.push(runtime);
    return runtime;
  });
  const inspectTelegramCredential = vi.fn(async (token: string) => ({
    status: "ready" as const,
    bot: { username: token.startsWith("new") ? "new_test_bot" : "cycling_test_bot" },
  }));
  const claimPrimaryOperator = vi.fn((_dataDir: string, senderId: string) => {
    if (senders.some((sender) => sender.role === "primary")) {
      return { status: "refused" as const, reason: "primary-exists" };
    }
    senders = [{ senderId, role: "primary", addedAt: "1998-06-01T00:00:00.000Z" }];
    return { status: "claimed" as const };
  });
  const listDesktopAllowedSenders = vi.fn(() => senders);
  const addSecondarySender = vi.fn((_dataDir: string, senderId: string) => {
    if (!senders.some((sender) => sender.senderId === senderId)) {
      senders = [...senders, { senderId, role: "additional" }];
    }
    return { status: "added" as const };
  });
  const removeSecondarySender = vi.fn((_dataDir: string, senderId: string) => {
    senders = senders.filter((sender) => sender.senderId !== senderId);
    return { status: "removed" as const };
  });
  const dependencies: DesktopTelegramControllerDependencies = {
    inspectTelegramCredential,
    deleteTelegramWebhook: vi.fn(async () => ({
      status: "ready" as const,
      bot: { username: "cycling_test_bot" },
    })),
    claimPrimaryOperator,
    listDesktopAllowedSenders,
    addSecondarySender,
    removeSecondarySender,
    pairingRandomBytes: () => Uint8Array.from([0xab, 0xcd, 0xef]),
    now: () => now,
    schedule: (callback, delayMs) => {
      const handle = { unref: vi.fn() } as unknown as ReturnType<typeof setTimeout>;
      scheduled.push({ callback, dueAt: now + delayMs, handle, canceled: false });
      return handle;
    },
    cancelSchedule: (handle) => {
      const timer = scheduled.find((candidate) => candidate.handle === handle);
      if (timer !== undefined) timer.canceled = true;
    },
  };
  const controller = createDesktopTelegramController(
    { dataDir: "/synthetic/athlete", createRuntime },
    dependencies,
  );
  return {
    addSecondarySender,
    advancePairingClock: async (milliseconds: number) => {
      now += milliseconds;
      for (const timer of scheduled) {
        if (!timer.canceled && timer.dueAt <= now) {
          timer.canceled = true;
          timer.callback();
        }
      }
      await settle();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    claimPrimaryOperator,
    controller,
    createRuntime,
    dependencies,
    inputs,
    inspectTelegramCredential,
    listDesktopAllowedSenders,
    removeSecondarySender,
    runtimes,
    senders: () => senders,
    setSenders: (value: typeof senders) => {
      senders = value;
    },
    starts,
    trace,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Desktop Telegram controller", () => {
  it("starts with an exact contract-valid redacted snapshot", () => {
    const { controller, createRuntime } = harness();

    expect(controller.getStatus()).toEqual({
      channel: { desiredState: "disabled", state: "disabled" },
      bot: { state: "unconfigured" },
      pairing: { state: "unpaired" },
    });
    expect(TelegramControlSnapshotSchema.parse(controller.getStatus())).toEqual(
      controller.getStatus(),
    );
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("reports paired on startup when the sender store already has a primary", async () => {
    const { controller, inputs } = harness({ primary: true });
    expect(controller.getStatus().pairing).toEqual({ state: "paired" });

    await controller.configure("old-secret-token");
    await controller.enable();
    inputs[0]!.onStarted();

    expect(controller.getStatus().channel).toEqual({
      desiredState: "enabled",
      state: "online",
    });
  });

  it("inspects before retaining a token and closes invalid or unavailable results", async () => {
    const h = harness();
    h.inspectTelegramCredential
      .mockResolvedValueOnce({ status: "invalid-token" })
      .mockResolvedValueOnce({
        status: "unavailable",
        errorCode: "telegram-validation-failed",
      });

    await h.controller.configure("invalid-secret-token");
    expect(h.controller.getStatus().bot).toEqual({ state: "unconfigured" });
    await h.controller.enable();
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "disabled",
      state: "disabled",
    });

    await h.controller.beginTelegramPairing();
    await h.controller.configure("unavailable-secret-token");
    expect(h.controller.getStatus()).toMatchObject({
      channel: {
        desiredState: "enabled",
        state: "failed",
        errorCode: "telegram-start-failed",
      },
      bot: { state: "unconfigured" },
    });
    expect(h.createRuntime).not.toHaveBeenCalled();
    expect(JSON.stringify(h.controller.getStatus())).not.toContain("secret-token");
  });

  it("retains and preserves webhook-removal-required state without polling", async () => {
    const h = harness({ primary: true });
    h.inspectTelegramCredential.mockResolvedValueOnce({
      status: "webhook-removal-required",
      bot: { username: "cycling_test_bot" },
    });

    await h.controller.configure("webhook-secret-token");
    await h.controller.enable();
    await h.controller.reconcile();

    expect(h.controller.getStatus()).toMatchObject({
      channel: {
        desiredState: "enabled",
        state: "conflict",
        errorCode: "telegram-polling-conflict",
      },
      bot: { state: "webhook-removal-required", username: "cycling_test_bot" },
    });
    expect(h.createRuntime).not.toHaveBeenCalled();
  });

  it("refuses ordinary enablement before a primary operator exists", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");

    const enabled = await h.controller.enable();

    expect(enabled.channel).toEqual({ desiredState: "disabled", state: "disabled" });
    expect(enabled.pairing).toEqual({ state: "unpaired" });
    expect(h.createRuntime).not.toHaveBeenCalled();
  });

  it("keeps the old runtime, bot, and token when replacement inspection is invalid", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.inputs[0]!.onStarted();
    h.inspectTelegramCredential.mockResolvedValueOnce({ status: "invalid-token" });

    await h.controller.replace("new-invalid-secret-token");

    expect(h.createRuntime).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.stop).not.toHaveBeenCalled();
    expect(h.controller.getStatus()).toMatchObject({
      channel: { state: "online" },
      bot: { state: "ready", username: "cycling_test_bot" },
    });

    await h.controller.disable();
    await h.controller.enable();
    expect(h.inputs[1]!.token).toBe("old-secret-token");
  });

  it.each([
    { status: "invalid-token" as const },
    {
      status: "webhook-removal-required" as const,
      bot: { username: "new_test_bot" },
    },
  ])("keeps an active valid pairing for a rejected replacement: $status", async (inspection) => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    h.inspectTelegramCredential.mockResolvedValueOnce(inspection);

    const result = await h.controller.replace("new-secret-token");

    expect(result.pairing).toMatchObject({ state: "awaiting-code", code: "ABCDEF" });
    expect(h.createRuntime).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.stop).not.toHaveBeenCalled();
    expect(result.bot).toEqual({ state: "ready", username: "cycling_test_bot" });
  });

  it("drains the old runtime before retaining and starting a valid replacement", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.trace.length = 0;

    await h.controller.replace("new-secret-token");

    expect(h.trace).toEqual([
      "stop:old-secret-token",
      "drain:old-secret-token",
      "start:new-secret-token",
    ]);
    expect(h.controller.getStatus().bot).toEqual({
      state: "ready",
      username: "new_test_bot",
    });
  });

  it("begins pairing on the canonical runtime and becomes online only after a primary claim", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");

    const begun = await h.controller.beginTelegramPairing();
    expect(begun).toMatchObject({
      channel: { desiredState: "enabled", state: "starting" },
      pairing: {
        state: "awaiting-code",
        code: "ABCDEF",
        expiresAt: "1998-06-01T12:01:00.000Z",
      },
    });
    expect(h.createRuntime).toHaveBeenCalledOnce();

    h.inputs[0]!.onStarted();
    expect(h.controller.getStatus().channel.state).toBe("starting");
    await expect(
      h.inputs[0]!.consumePairing({
        senderId: "12345",
        senderName: "Athlete",
        messageText: "wrong",
      }),
    ).resolves.toBe(false);
    await expect(
      h.inputs[0]!.consumePairing({
        senderId: "12345",
        senderName: "Athlete",
        messageText: " ABCDEF ",
      }),
    ).resolves.toBe(true);

    expect(h.claimPrimaryOperator).toHaveBeenCalledOnce();
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "enabled", state: "online" },
      pairing: { state: "paired" },
    });
    await expect(
      h.inputs[0]!.consumePairing({
        senderId: "67890",
        senderName: undefined,
        messageText: "ABCDEF",
      }),
    ).resolves.toBe(true);
    expect(h.claimPrimaryOperator).toHaveBeenCalledOnce();

    await h.controller.beginTelegramPairing();
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("cancels pairing by stopping and draining its pre-ownership runtime", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();

    const canceled = await h.controller.cancelTelegramPairing();

    expect(canceled.pairing).toEqual({ state: "unpaired" });
    expect(canceled.channel).toEqual({ desiredState: "disabled", state: "disabled" });
    expect(h.createRuntime).toHaveBeenCalledOnce();
    expect(h.trace).toEqual([
      "start:old-secret-token",
      "stop:old-secret-token",
      "drain:old-secret-token",
    ]);
    await expect(
      h.inputs[0]!.consumePairing({
        senderId: "12345",
        senderName: undefined,
        messageText: "ABCDEF",
      }),
    ).resolves.toBe(false);
  });

  it("stops and drains the pre-ownership runtime when the pairing code expires", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    h.trace.length = 0;

    await h.advancePairingClock(60_000);

    expect(h.trace).toEqual(["stop:old-secret-token", "drain:old-secret-token"]);
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "expired" },
    });
  });

  it.each(["disable", "replace", "forget", "close"] as const)(
    "%s cancels an active pairing window",
    async (operation) => {
      const h = harness();
      await h.controller.configure("old-secret-token");
      await h.controller.beginTelegramPairing();

      if (operation === "disable") await h.controller.disable();
      else if (operation === "replace") await h.controller.replace("new-secret-token");
      else if (operation === "forget") await h.controller.forgetTelegramCredential();
      else await h.controller.close();

      expect(h.controller.getStatus().pairing).toEqual({ state: "unpaired" });
    },
  );

  it("forgets only after the active runtime has stopped and drained", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.trace.length = 0;

    const forgotten = await h.controller.forgetTelegramCredential();

    expect(h.trace).toEqual(["stop:old-secret-token", "drain:old-secret-token"]);
    expect(forgotten).toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      bot: { state: "unconfigured" },
    });
    await h.controller.enable();
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "enabled",
      state: "waiting-for-credential",
    });
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("updates a retained webhook credential after explicit deletion and reinspection", async () => {
    const h = harness({ primary: true });
    h.inspectTelegramCredential.mockResolvedValueOnce({
      status: "webhook-removal-required",
      bot: { username: "cycling_test_bot" },
    });
    await h.controller.configure("webhook-secret-token");
    await h.controller.enable();

    await expect(h.controller.deleteTelegramWebhook("webhook-secret-token")).resolves.toEqual({
      status: "ready",
      bot: { username: "cycling_test_bot" },
    });

    expect(h.controller.getStatus().bot).toEqual({
      state: "ready",
      username: "cycling_test_bot",
    });
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("projects strict numeric allowed-sender results and delegates secondary mutations", async () => {
    const h = harness({ primary: true });
    h.setSenders([
      { senderId: "12345", role: "primary", addedAt: "1998-06-01T00:00:00.000Z" },
      { senderId: "67890", role: "additional" },
    ]);

    await expect(h.controller.listTelegramAllowedSenders()).resolves.toEqual({
      senders: [
        { senderId: 12345, role: "primary", addedAt: "1998-06-01T00:00:00.000Z" },
        { senderId: 67890, role: "additional" },
      ],
    });
    await h.controller.addTelegramAllowedSender(77777);
    expect(h.addSecondarySender).toHaveBeenCalledWith("/synthetic/athlete", "77777");
    await h.controller.removeTelegramAllowedSender(67890);
    expect(h.removeSecondarySender).toHaveBeenCalledWith("/synthetic/athlete", "67890");

    h.setSenders([
      { senderId: "12345", role: "primary", addedAt: "not-a-date" },
      { senderId: "999999999999999999999", role: "additional" },
    ]);
    await expect(h.controller.listTelegramAllowedSenders()).rejects.toThrow(
      "Telegram sender state is inconsistent",
    );
  });

  it("supports ordered polling suspension, drain, and resume", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.trace.length = 0;

    await h.controller.stopPolling();
    await h.controller.drainPending();
    await h.controller.resumePolling();

    expect(h.trace).toEqual([
      "stop:old-secret-token",
      "drain:old-secret-token",
      "start:old-secret-token",
    ]);
    expect(h.runtimes[0]!.start).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "invalid-token", "telegram-invalid-token"],
    [409, "conflict", "telegram-polling-conflict"],
    [500, "failed", "telegram-start-failed"],
  ] as const)(
    "maps polling error %i to a closed redacted snapshot",
    async (code, state, errorCode) => {
      const h = harness({ primary: true });
      await h.controller.configure("old-secret-token");
      await h.controller.enable();

      h.starts[0]!.reject({
        error_code: code,
        description: "old-secret-token https://api.telegram.org/botold-secret-token/getUpdates",
      });
      await settle();

      expect(h.controller.getStatus().channel).toEqual({
        desiredState: "enabled",
        state,
        errorCode,
      });
      expect(JSON.stringify(h.controller.getStatus())).not.toContain("secret-token");
      expect(TelegramControlSnapshotSchema.safeParse(h.controller.getStatus()).success).toBe(true);
    },
  );
});
