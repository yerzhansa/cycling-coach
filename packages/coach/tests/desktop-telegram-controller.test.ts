import { describe, expect, it, vi } from "vitest";
import { TelegramControlSnapshotSchema } from "@enduragent/coach-contract";
import { AllowedSendersCommitUncertainError } from "@enduragent/core";
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

function harness(
  options: {
    readonly primary?: boolean;
    readonly legacyPrimary?: boolean;
    readonly pairingRandomBytes?: (size: number) => Uint8Array;
  } = {},
) {
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
    options.primary || options.legacyPrimary
      ? [{ senderId: "12345", role: "primary", addedAt: "1998-06-01T00:00:00.000Z" }]
      : [];
  let accessBinding = options.primary ? "10001" : undefined;
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
      captureDrain: vi.fn(() => ({
        wait: vi.fn(async () => {
          trace.push(`drain:${input.token}`);
        }),
      })),
    };
    runtimes.push(runtime);
    return runtime;
  });
  const inspectTelegramCredential = vi.fn<
    NonNullable<DesktopTelegramControllerDependencies["inspectTelegramCredential"]>
  >(async (token: string) => ({
    status: "ready" as const,
    bot: {
      id: token.startsWith("new") ? 20002 : 10001,
      username: token.startsWith("new") ? "new_test_bot" : "cycling_test_bot",
    },
  }));
  const claimPrimaryOperator = vi.fn<
    NonNullable<DesktopTelegramControllerDependencies["claimPrimaryOperator"]>
  >((_dataDir: string, senderId: string) => {
    if (senders.some((sender) => sender.role === "primary")) {
      return { status: "refused" as const, reason: "primary-exists" };
    }
    senders = [{ senderId, role: "primary", addedAt: "1998-06-01T00:00:00.000Z" }];
    return { status: "claimed" as const };
  });
  const listDesktopAllowedSenders = vi.fn(() => senders);
  const addSecondarySender = vi.fn<
    NonNullable<DesktopTelegramControllerDependencies["addSecondarySender"]>
  >((_dataDir: string, senderId: string) => {
    if (!senders.some((sender) => sender.senderId === senderId)) {
      senders = [...senders, { senderId, role: "additional" }];
    }
    return { status: "added" as const, sender: { senderId, role: "additional" as const } };
  });
  const removeSecondarySender = vi.fn<
    NonNullable<DesktopTelegramControllerDependencies["removeSecondarySender"]>
  >((_dataDir: string, senderId: string) => {
    senders = senders.filter((sender) => sender.senderId !== senderId);
    return { status: "removed" as const };
  });
  const resetDesktopAllowedSenders = vi.fn(() => {
    senders = [];
    accessBinding = undefined;
  });
  const bindDesktopTelegramAccess = vi.fn((_dataDir: string, binding: string) => {
    if (binding === accessBinding) return "preserved" as const;
    accessBinding = binding;
    senders = [];
    return "reset" as const;
  });
  const dependencies: DesktopTelegramControllerDependencies = {
    inspectTelegramCredential,
    deleteTelegramWebhook: vi.fn(async () => ({
      status: "ready" as const,
      bot: { id: 10001, username: "cycling_test_bot" },
    })),
    claimPrimaryOperator,
    listDesktopAllowedSenders,
    addSecondarySender,
    removeSecondarySender,
    resetDesktopAllowedSenders,
    bindDesktopTelegramAccess,
    pairingRandomBytes: options.pairingRandomBytes ?? (() => Uint8Array.from([0xab, 0xcd, 0xef])),
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
  const queueDuePairingTimers = (milliseconds: number): void => {
    now += milliseconds;
    for (const timer of scheduled) {
      if (!timer.canceled && timer.dueAt <= now) {
        timer.canceled = true;
        timer.callback();
      }
    }
  };
  return {
    addSecondarySender,
    advancePairingClock: async (milliseconds: number) => {
      queueDuePairingTimers(milliseconds);
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
    queueDuePairingTimers,
    removeSecondarySender,
    resetDesktopAllowedSenders,
    bindDesktopTelegramAccess,
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
    expect(controller.getStatus().channel).toEqual({
      desiredState: "disabled",
      state: "disabled",
    });
    expect(inputs).toEqual([]);
    await controller.enable();
    inputs[0]!.onStarted();
    inputs[0]!.onPollingSuccess();

    expect(controller.getStatus().channel).toEqual({
      desiredState: "enabled",
      state: "online",
      lastSuccessfulPollAt: "1998-06-01T12:00:00.000Z",
    });
    expect(controller.getStatus().pairing).toEqual({ state: "paired" });
  });

  it("clears an unbound npm-era sender list before accepting the first Desktop bot", async () => {
    const h = harness({ legacyPrimary: true });

    const configured = await h.controller.configure("old-secret-token");

    expect(h.bindDesktopTelegramAccess).toHaveReturnedWith("reset");
    expect(h.senders()).toEqual([]);
    expect(configured).toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "unpaired" },
      },
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

    await expect(h.controller.configure("invalid-secret-token")).resolves.toEqual({
      outcome: "refused",
      reason: "invalid-token",
      current: h.controller.getStatus(),
    });
    expect(h.controller.getStatus().bot).toEqual({ state: "unconfigured" });
    await h.controller.enable();
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "disabled",
      state: "disabled",
    });

    await h.controller.beginTelegramPairing();
    const beforeUnavailable = h.controller.getStatus();
    await expect(h.controller.configure("unavailable-secret-token")).resolves.toEqual({
      outcome: "refused",
      reason: "validation-unavailable",
      current: beforeUnavailable,
    });
    expect(h.controller.getStatus()).toEqual(beforeUnavailable);
    expect(h.createRuntime).not.toHaveBeenCalled();
    expect(JSON.stringify(h.controller.getStatus())).not.toContain("secret-token");
  });

  it("refuses webhook candidates without retaining or polling them", async () => {
    const h = harness({ primary: true });
    h.inspectTelegramCredential.mockResolvedValueOnce({
      status: "webhook-removal-required",
      bot: { id: 10001, username: "cycling_test_bot" },
    });

    await expect(h.controller.configure("old-secret-token")).resolves.toEqual({
      outcome: "refused",
      reason: "webhook-removal-required",
      current: h.controller.getStatus(),
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

  it("refuses configure over an existing credential and replacement without one", async () => {
    const configured = harness();
    await configured.controller.configure("old-secret-token");
    const existing = configured.controller.getStatus();
    await expect(configured.controller.configure("new-secret-token")).resolves.toEqual({
      outcome: "refused",
      reason: "invalid-state",
      current: existing,
    });

    const unconfigured = harness();
    const empty = unconfigured.controller.getStatus();
    await expect(unconfigured.controller.replace("new-secret-token")).resolves.toEqual({
      outcome: "refused",
      reason: "invalid-state",
      current: empty,
    });
    expect(configured.inspectTelegramCredential).toHaveBeenCalledOnce();
    expect(unconfigured.inspectTelegramCredential).not.toHaveBeenCalled();
  });

  it("keeps the old runtime, bot, and token when replacement inspection is invalid", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.inputs[0]!.onStarted();
    h.inputs[0]!.onPollingSuccess();
    h.inspectTelegramCredential.mockResolvedValueOnce({ status: "invalid-token" });

    await expect(h.controller.replace("new-invalid-secret-token")).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-token",
    });

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
    { status: "unavailable" as const, errorCode: "telegram-validation-failed" as const },
    {
      status: "webhook-removal-required" as const,
      bot: { id: 20002, username: "new_test_bot" },
    },
  ])("keeps an active valid pairing for a rejected replacement: $status", async (inspection) => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    h.inspectTelegramCredential.mockResolvedValueOnce(inspection);

    const result = await h.controller.replace("new-secret-token");

    expect(result.current.pairing).toMatchObject({ state: "awaiting-code", code: "ABCDEF" });
    expect(h.createRuntime).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.stop).not.toHaveBeenCalled();
    expect(result.current.bot).toEqual({ state: "ready", username: "cycling_test_bot" });
  });

  it("drains the old runtime and requires fresh pairing for a valid replacement", async () => {
    const h = harness({ primary: true });
    h.setSenders([
      { senderId: "12345", role: "primary" },
      { senderId: "67890", role: "additional" },
    ]);
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.trace.length = 0;

    const replaced = await h.controller.replace("new-secret-token");

    expect(h.trace).toEqual(["stop:old-secret-token", "drain:old-secret-token"]);
    expect(h.bindDesktopTelegramAccess).toHaveReturnedWith("reset");
    expect(h.senders()).toEqual([]);
    expect(replaced).toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "unpaired" },
      },
    });
    expect(replaced.current.bot).toEqual({
      state: "ready",
      username: "new_test_bot",
    });
    expect(h.createRuntime).toHaveBeenCalledOnce();

    const pairing = await h.controller.beginTelegramPairing();
    expect(pairing.pairing).toMatchObject({ state: "awaiting-code" });
    expect(h.inputs[1]!.token).toBe("new-secret-token");
  });

  it("retires a pairing consumer queued behind replacement before waiting for drain", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    const inspection = deferred<{
      readonly status: "ready";
      readonly bot: { readonly id: 20002; readonly username: "new_test_bot" };
    }>();
    h.inspectTelegramCredential.mockImplementationOnce(() => inspection.promise);

    const replacing = h.controller.replace("new-secret-token");
    await vi.waitFor(() => expect(h.inspectTelegramCredential).toHaveBeenCalledTimes(2));
    const consumed = h.inputs[0]!.consumePairing({
      senderId: "12345",
      senderName: "Athlete",
      messageText: "ABCDEF",
    });
    const drainWait = vi.fn(async () => {
      await expect(consumed).resolves.toBe(false);
    });
    vi.mocked(h.runtimes[0]!.captureDrain).mockReturnValueOnce({ wait: drainWait });
    inspection.resolve({
      status: "ready",
      bot: { id: 20002, username: "new_test_bot" },
    });

    await expect(replacing).resolves.toMatchObject({ outcome: "applied" });
    await expect(consumed).resolves.toBe(false);
    expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(drainWait).toHaveBeenCalledOnce();
    expect(h.claimPrimaryOperator).not.toHaveBeenCalled();
  });

  it("keeps a queued pairing claim coherent when replacement stop rolls back", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    const inspection = deferred<{
      readonly status: "ready";
      readonly bot: { readonly id: 20002; readonly username: "new_test_bot" };
    }>();
    const stop = deferred<void>();
    h.inspectTelegramCredential.mockImplementationOnce(() => inspection.promise);
    vi.mocked(h.runtimes[0]!.stop).mockImplementationOnce(() => stop.promise);

    const replacing = h.controller.replace("new-secret-token");
    await vi.waitFor(() => expect(h.inspectTelegramCredential).toHaveBeenCalledTimes(2));
    const consumed = h.inputs[0]!.consumePairing({
      senderId: "12345",
      senderName: "Athlete",
      messageText: "ABCDEF",
    });
    let consumedResult: boolean | undefined;
    void consumed.then((result) => {
      consumedResult = result;
    });
    inspection.resolve({
      status: "ready",
      bot: { id: 20002, username: "new_test_bot" },
    });
    await vi.waitFor(() => expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce());
    await settle();
    expect(consumedResult).toBeUndefined();

    stop.reject(new Error("synthetic stop failure"));
    await expect(replacing).resolves.toMatchObject({
      outcome: "refused",
      reason: "release-refused",
    });
    await expect(consumed).resolves.toBe(true);

    expect(h.claimPrimaryOperator).toHaveBeenCalledOnce();
    expect(h.senders()).toEqual([
      {
        senderId: "12345",
        role: "primary",
        addedAt: "1998-06-01T00:00:00.000Z",
      },
    ]);
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "enabled", state: "starting" },
      bot: { state: "ready", username: "cycling_test_bot" },
      pairing: { state: "paired" },
    });
    expect(h.inputs[0]!.admitted()).toBe(true);
    expect(h.runtimes[0]!.captureDrain).not.toHaveBeenCalled();
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("converges an exact-token replacement without releasing or restarting its runtime", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.inputs[0]!.onPollingSuccess();

    const replayed = await h.controller.replace("old-secret-token");

    expect(replayed.current.channel).toMatchObject({ state: "online" });
    expect(h.inspectTelegramCredential).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.stop).not.toHaveBeenCalled();
    expect(h.runtimes[0]!.captureDrain).not.toHaveBeenCalled();
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it.each(["stop", "drain"] as const)(
    "refuses replacement when old-runtime %s proof fails",
    async (stage) => {
      const h = harness({ primary: true });
      await h.controller.configure("old-secret-token");
      await h.controller.enable();
      h.inputs[0]!.onStarted();
      h.inputs[0]!.onPollingSuccess();
      const runtime = h.runtimes[0]!;
      const refusal = new Error(`${stage} refused`);
      const retryGate = deferred<void>();
      const drainWait = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(refusal)
        .mockImplementation(() => retryGate.promise);
      if (stage === "stop") vi.mocked(runtime.stop).mockRejectedValueOnce(refusal);
      else vi.mocked(runtime.captureDrain).mockReturnValueOnce({ wait: drainWait });

      const replacement = h.controller.replace("new-secret-token");

      await expect(replacement).resolves.toMatchObject({
        outcome: "refused",
        reason: "release-refused",
      });
      expect(h.createRuntime).toHaveBeenCalledTimes(stage === "drain" ? 2 : 1);
      expect(runtime.stop).toHaveBeenCalledOnce();
      expect(runtime.captureDrain).toHaveBeenCalledTimes(stage === "drain" ? 1 : 0);
      expect(runtime.start).toHaveBeenCalledOnce();
      if (stage === "stop") {
        expect(h.inputs[0]!.admitted()).toBe(true);
        expect(h.createRuntime).toHaveBeenCalledOnce();
        h.inputs[0]!.onPollingFailure();
        expect(h.controller.getStatus().channel).toMatchObject({ state: "offline-retrying" });
        h.inputs[0]!.onPollingSuccess();
      }
      if (stage === "drain") {
        expect(h.controller.getStatus().channel).toMatchObject({ state: "starting" });
        expect(h.runtimes[1]!.start).toHaveBeenCalledOnce();
        h.inputs[1]!.onPollingSuccess();
      }
      expect(h.controller.getStatus()).toMatchObject({
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "ready", username: "cycling_test_bot" },
        pairing: { state: "paired" },
      });

      if (stage === "drain") {
        const disabling = h.controller.disable();
        await vi.waitFor(() => expect(drainWait).toHaveBeenCalledTimes(2));
        let disabled = false;
        void disabling.then(() => {
          disabled = true;
        });
        await settle();
        expect(disabled).toBe(false);
        retryGate.resolve();
        await disabling;
      } else {
        await h.controller.disable();
      }
      await h.controller.enable();
      expect(h.inputs[stage === "drain" ? 2 : 1]!.token).toBe("old-secret-token");
    },
  );

  it("keeps the current runtime admitted when disable cannot stop it", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.inputs[0]!.onStarted();
    h.inputs[0]!.onPollingSuccess();
    vi.mocked(h.runtimes[0]!.stop).mockRejectedValueOnce(new Error("synthetic stop failure"));

    await expect(h.controller.disable()).rejects.toThrow(
      "Desktop Telegram runtime release was refused",
    );
    expect(h.inputs[0]!.admitted()).toBe(true);
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: "cycling_test_bot" },
      pairing: { state: "paired" },
    });
    expect(h.runtimes[0]!.captureDrain).not.toHaveBeenCalled();
    expect(h.createRuntime).toHaveBeenCalledOnce();

    await h.controller.disable();
    expect(h.inputs[0]!.admitted()).toBe(false);
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "disabled",
      state: "disabled",
    });
    expect(h.runtimes[0]!.stop).toHaveBeenCalledTimes(2);
    expect(h.runtimes[0]!.captureDrain).toHaveBeenCalledOnce();
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("does not misreport an uncertain access bind as a release refusal", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.bindDesktopTelegramAccess.mockImplementationOnce(() => {
      throw new AllowedSendersCommitUncertainError(
        "/synthetic/athlete",
        new Error("synthetic durability uncertainty"),
      );
    });

    const replacement = h.controller.replace("new-secret-token");

    await expect(replacement).rejects.toBeInstanceOf(AllowedSendersCommitUncertainError);
    expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.captureDrain).toHaveBeenCalledOnce();
  });

  it("keeps the pre-ownership runtime online after it claims the primary", async () => {
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
    h.inputs[0]!.onPollingSuccess();
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
    expect(h.inputs[0]!.admitted()).toBe(true);
    expect(h.runtimes[0]!.stop).not.toHaveBeenCalled();
    expect(h.runtimes[0]!.captureDrain).not.toHaveBeenCalled();
    await expect(
      h.inputs[0]!.consumePairing({
        senderId: "67890",
        senderName: undefined,
        messageText: "ABCDEF",
      }),
    ).resolves.toBe(true);
    expect(h.claimPrimaryOperator).toHaveBeenCalledOnce();

    await h.advancePairingClock(60_000);
    await h.controller.beginTelegramPairing();
    expect(h.controller.getStatus().channel.state).toBe("online");
    expect(h.createRuntime).toHaveBeenCalledOnce();
    expect(h.inputs[0]!.admitted()).toBe(true);
  });

  it("releases retirement subscribers after fast pairing checks on a live generation", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();

    await expect(
      Promise.all(
        Array.from({ length: 256 }, (_, index) =>
          h.inputs[0]!.consumePairing({
            senderId: "12345",
            senderName: "Athlete",
            messageText: `WRONG-${index}`,
          }),
        ),
      ),
    ).resolves.toEqual(Array.from({ length: 256 }, () => false));

    const active = (
      h.controller as unknown as {
        readonly active?: { readonly retirementListeners: ReadonlySet<unknown> };
      }
    ).active;
    expect(active?.retirementListeners.size).toBe(0);
    expect(h.inputs[0]!.admitted()).toBe(true);
    expect(h.runtimes[0]!.stop).not.toHaveBeenCalled();
  });

  it("keeps the claimed generation online when the claim wins a serialized cancel race", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    h.inputs[0]!.onStarted();
    h.inputs[0]!.onPollingSuccess();

    const claimed = h.inputs[0]!.consumePairing({
      senderId: "12345",
      senderName: "Athlete",
      messageText: "ABCDEF",
    });
    const canceled = h.controller.cancelTelegramPairing();

    await expect(claimed).resolves.toBe(true);
    await canceled;
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "enabled", state: "online" },
      pairing: { state: "paired" },
    });
    expect(h.inputs[0]!.admitted()).toBe(true);
    expect(h.runtimes[0]!.stop).not.toHaveBeenCalled();
    expect(h.runtimes[0]!.captureDrain).not.toHaveBeenCalled();
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("closes the generation when cancellation wins a serialized claim race", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();

    const canceled = h.controller.cancelTelegramPairing();
    const claimed = h.inputs[0]!.consumePairing({
      senderId: "12345",
      senderName: "Athlete",
      messageText: "ABCDEF",
    });

    await expect(canceled).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "unpaired" },
    });
    await expect(claimed).resolves.toBe(false);
    expect(h.claimPrimaryOperator).not.toHaveBeenCalled();
    expect(h.inputs[0]!.admitted()).toBe(false);
    expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.captureDrain).toHaveBeenCalledOnce();
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("retires the pre-ownership runtime when storing the consumed pairing claim throws", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    h.claimPrimaryOperator.mockImplementationOnce(() => {
      throw new Error("synthetic storage failure");
    });

    await expect(
      h.inputs[0]!.consumePairing({
        senderId: "12345",
        senderName: "Athlete",
        messageText: "ABCDEF",
      }),
    ).resolves.toBe(true);

    expect(h.inputs[0]!.admitted()).toBe(false);
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "failed", errorCode: "telegram-pairing-storage-failed" },
    });
    await settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.captureDrain).toHaveBeenCalledOnce();
    expect(h.trace).toEqual([
      "start:old-secret-token",
      "stop:old-secret-token",
      "drain:old-secret-token",
    ]);

    await h.advancePairingClock(60_000);
    expect(h.controller.getStatus().pairing).toEqual({
      state: "failed",
      errorCode: "telegram-pairing-storage-failed",
    });
    expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce();
  });

  it("seals and drains pre-ownership admission when the primary claim commit is uncertain", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    h.claimPrimaryOperator.mockReturnValueOnce({ status: "uncertain" });

    await expect(
      h.inputs[0]!.consumePairing({
        senderId: "12345",
        senderName: "Athlete",
        messageText: "ABCDEF",
      }),
    ).resolves.toBe(true);

    expect(h.inputs[0]!.admitted()).toBe(false);
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
    });
    await settle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.captureDrain).toHaveBeenCalledOnce();
    expect(h.trace).toEqual([
      "start:old-secret-token",
      "stop:old-secret-token",
      "drain:old-secret-token",
    ]);
    expect(h.senders()).toEqual([]);
  });

  it.each(["stop", "drain"] as const)(
    "keeps failed-claim %s cleanup debt closed until an explicit re-pair",
    async (stage) => {
      const entropy = vi
        .fn<(size: number) => Uint8Array>()
        .mockReturnValueOnce(Uint8Array.from([0xab, 0xcd, 0xef]))
        .mockReturnValue(Uint8Array.from([1, 2, 3]));
      const h = harness({ pairingRandomBytes: entropy });
      await h.controller.configure("old-secret-token");
      await h.controller.beginTelegramPairing();
      h.claimPrimaryOperator.mockImplementationOnce(() => {
        throw new Error("synthetic storage failure");
      });
      const cleanupFailure = new Error(`synthetic ${stage} failure`);
      const drain = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(cleanupFailure)
        .mockResolvedValueOnce(undefined);
      if (stage === "stop") {
        vi.mocked(h.runtimes[0]!.stop).mockRejectedValueOnce(cleanupFailure);
      } else {
        vi.mocked(h.runtimes[0]!.captureDrain).mockReturnValueOnce({ wait: drain });
      }

      await h.inputs[0]!.consumePairing({
        senderId: "12345",
        senderName: "Athlete",
        messageText: "ABCDEF",
      });
      await settle();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(h.inputs[0]!.admitted()).toBe(false);
      expect(h.controller.getStatus()).toMatchObject({
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "failed", errorCode: "telegram-pairing-storage-failed" },
      });
      expect(h.createRuntime).toHaveBeenCalledOnce();

      await h.advancePairingClock(60_000);
      expect(h.controller.getStatus().pairing).toMatchObject({ state: "failed" });
      expect(h.createRuntime).toHaveBeenCalledOnce();

      const repaired = await h.controller.beginTelegramPairing();

      expect(h.runtimes[0]!.stop).toHaveBeenCalledTimes(stage === "stop" ? 2 : 1);
      if (stage === "drain") expect(drain).toHaveBeenCalledTimes(2);
      expect(repaired.pairing).toMatchObject({ state: "awaiting-code", code: "010203" });
      expect(h.createRuntime).toHaveBeenCalledTimes(2);
      expect(h.inputs[0]!.admitted()).toBe(false);
      expect(h.inputs[1]!.admitted()).toBe(true);
    },
  );

  it("reports polling outages without starting a second retry loop", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.inputs[0]!.onStarted();

    h.inputs[0]!.onPollingFailure();
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "enabled",
      state: "offline-retrying",
    });

    h.inputs[0]!.onPollingSuccess();
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "enabled",
      state: "online",
      lastSuccessfulPollAt: "1998-06-01T12:00:00.000Z",
    });
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

  it("keeps the claimed generation online when the claim precedes expiry", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    h.inputs[0]!.onStarted();
    h.inputs[0]!.onPollingSuccess();

    await expect(
      h.inputs[0]!.consumePairing({
        senderId: "12345",
        senderName: "Athlete",
        messageText: "ABCDEF",
      }),
    ).resolves.toBe(true);
    h.queueDuePairingTimers(60_000);
    await settle();

    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "enabled", state: "online" },
      pairing: { state: "paired" },
    });
    expect(h.inputs[0]!.admitted()).toBe(true);
    expect(h.runtimes[0]!.stop).not.toHaveBeenCalled();
    expect(h.runtimes[0]!.captureDrain).not.toHaveBeenCalled();
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("closes the generation when expiry precedes a serialized claim", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();

    h.queueDuePairingTimers(60_000);
    const claimed = h.inputs[0]!.consumePairing({
      senderId: "12345",
      senderName: "Athlete",
      messageText: "ABCDEF",
    });

    await expect(claimed).resolves.toBe(false);
    expect(h.claimPrimaryOperator).not.toHaveBeenCalled();
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "expired" },
    });
    expect(h.inputs[0]!.admitted()).toBe(false);
    expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.captureDrain).toHaveBeenCalledOnce();
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("keeps expiry disabled and retries cleanup after its first stop is rejected", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    vi.mocked(h.runtimes[0]!.stop).mockRejectedValueOnce(new Error("synthetic stop failure"));

    await h.advancePairingClock(60_000);

    expect(h.inputs[0]!.admitted()).toBe(false);
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "expired" },
    });
    expect(h.createRuntime).toHaveBeenCalledOnce();

    await h.controller.reconcile();
    expect(h.runtimes[0]!.stop).toHaveBeenCalledTimes(2);
    expect(h.createRuntime).toHaveBeenCalledOnce();
    await h.controller.beginTelegramPairing();
    expect(h.createRuntime).toHaveBeenCalledTimes(2);
    expect(h.inputs[1]!.admitted()).toBe(true);
  });

  it("keeps cancellation disabled when its first stop is rejected", async () => {
    const h = harness();
    await h.controller.configure("old-secret-token");
    await h.controller.beginTelegramPairing();
    vi.mocked(h.runtimes[0]!.stop).mockRejectedValueOnce(new Error("synthetic stop failure"));

    await expect(h.controller.cancelTelegramPairing()).rejects.toThrow(
      "Desktop Telegram runtime release was refused",
    );
    expect(h.inputs[0]!.admitted()).toBe(false);
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "unpaired" },
    });
    expect(h.createRuntime).toHaveBeenCalledOnce();

    await h.controller.reconcile();
    expect(h.runtimes[0]!.stop).toHaveBeenCalledTimes(2);
    expect(h.createRuntime).toHaveBeenCalledOnce();
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

  it.each(["disable", "forget", "reset", "close"] as const)(
    "%s retires a pairing consumer queued behind runtime release",
    async (operation) => {
      const h = harness();
      await h.controller.configure("old-secret-token");
      await h.controller.beginTelegramPairing();
      let consumed!: Promise<boolean>;
      const drainWait = vi.fn(async () => {
        await expect(consumed).resolves.toBe(false);
      });
      vi.mocked(h.runtimes[0]!.captureDrain).mockReturnValueOnce({ wait: drainWait });

      const releasing =
        operation === "disable"
          ? h.controller.disable()
          : operation === "forget"
            ? h.controller.forgetTelegramCredential()
            : operation === "reset"
              ? h.controller.resetTelegramAccess()
              : h.controller.close();
      consumed = h.inputs[0]!.consumePairing({
        senderId: "12345",
        senderName: "Athlete",
        messageText: "ABCDEF",
      });

      await expect(releasing).resolves.toBeDefined();
      await expect(consumed).resolves.toBe(false);
      expect(drainWait).toHaveBeenCalledOnce();
      expect(h.claimPrimaryOperator).not.toHaveBeenCalled();
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

  it("resets all sender authorization before a newly configured bot can pair", async () => {
    const h = harness({ primary: true });
    h.setSenders([
      { senderId: "12345", role: "primary" },
      { senderId: "67890", role: "additional" },
    ]);
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    await h.controller.disable();

    const reset = await h.controller.resetTelegramAccess();

    expect(h.resetDesktopAllowedSenders).toHaveBeenCalledWith("/synthetic/athlete");
    expect(reset).toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      bot: { state: "ready", username: "cycling_test_bot" },
      pairing: { state: "unpaired" },
    });
    await expect(h.controller.listTelegramAllowedSenders()).resolves.toEqual({ senders: [] });

    await h.controller.forgetTelegramCredential();
    await h.controller.configure("new-secret-token");
    await expect(h.controller.enable()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "unpaired" },
    });
    const pairing = await h.controller.beginTelegramPairing();
    expect(pairing.pairing).toMatchObject({ state: "awaiting-code" });
    await expect(
      h.inputs[1]!.consumePairing({
        senderId: "12345",
        senderName: undefined,
        messageText: "ordinary message",
      }),
    ).resolves.toBe(false);
    expect(h.claimPrimaryOperator).not.toHaveBeenCalled();
  });

  it("keeps bot, token, and sender state when access reset persistence fails", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.inputs[0]!.onPollingSuccess();
    h.resetDesktopAllowedSenders.mockImplementationOnce(() => {
      throw new Error("storage refused");
    });

    await expect(h.controller.resetTelegramAccess()).rejects.toThrow("storage refused");

    expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.captureDrain).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.start).toHaveBeenCalledOnce();
    expect(h.createRuntime).toHaveBeenCalledTimes(2);
    expect(h.runtimes[1]!.start).toHaveBeenCalledOnce();
    expect(h.controller.getStatus().channel).toMatchObject({ state: "starting" });
    h.inputs[1]!.onPollingSuccess();
    expect(h.controller.getStatus()).toMatchObject({
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: "cycling_test_bot" },
      pairing: { state: "paired" },
    });
    expect(h.senders()).toHaveLength(1);
    expect(h.inputs[1]!.token).toBe("old-secret-token");
    expect(h.createRuntime).toHaveBeenCalledTimes(2);
  });

  it("carries the latest canonical polling success into online and retrying status", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();

    h.inputs[0]!.onPollingSuccess();
    expect(h.controller.getStatus().channel).toMatchObject({
      state: "online",
      lastSuccessfulPollAt: "1998-06-01T12:00:00.000Z",
    });
    await h.advancePairingClock(5_000);
    h.inputs[0]!.onPollingFailure();
    expect(h.controller.getStatus().channel).toMatchObject({
      state: "offline-retrying",
      lastSuccessfulPollAt: "1998-06-01T12:00:00.000Z",
    });
    h.inputs[0]!.onPollingSuccess();
    expect(h.controller.getStatus().channel).toMatchObject({
      state: "online",
      lastSuccessfulPollAt: "1998-06-01T12:00:05.000Z",
    });
  });

  it("accepts a webhook candidate only after explicit deletion and reinspection", async () => {
    const h = harness({ primary: true });
    h.inspectTelegramCredential.mockResolvedValueOnce({
      status: "webhook-removal-required",
      bot: { id: 10001, username: "cycling_test_bot" },
    });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();

    await expect(h.controller.deleteTelegramWebhook("old-secret-token")).resolves.toEqual({
      status: "ready",
      bot: { id: 10001, username: "cycling_test_bot" },
    });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();

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
    await expect(h.controller.addTelegramAllowedSender(77777)).resolves.toEqual({
      outcome: "applied",
      current: {
        senders: [
          { senderId: 12345, role: "primary", addedAt: "1998-06-01T00:00:00.000Z" },
          { senderId: 67890, role: "additional" },
          { senderId: 77777, role: "additional" },
        ],
      },
    });
    expect(h.addSecondarySender).toHaveBeenCalledWith("/synthetic/athlete", "77777");
    await expect(h.controller.removeTelegramAllowedSender(67890)).resolves.toEqual({
      outcome: "applied",
      current: {
        senders: [
          { senderId: 12345, role: "primary", addedAt: "1998-06-01T00:00:00.000Z" },
          { senderId: 77777, role: "additional" },
        ],
      },
    });
    expect(h.removeSecondarySender).toHaveBeenCalledWith("/synthetic/athlete", "67890");

    h.setSenders([
      { senderId: "12345", role: "primary", addedAt: "not-a-date" },
      { senderId: "999999999999999999999", role: "additional" },
    ]);
    await expect(h.controller.listTelegramAllowedSenders()).rejects.toThrow(
      "Telegram sender state is inconsistent",
    );
  });

  it.each(["add", "remove"] as const)(
    "returns a redacted storage uncertainty without reading sender state after %s",
    async (operation) => {
      const h = harness({ primary: true });
      h.listDesktopAllowedSenders.mockClear();
      if (operation === "add") {
        h.addSecondarySender.mockReturnValueOnce({ status: "uncertain" } as never);
      } else {
        h.removeSecondarySender.mockReturnValueOnce({ status: "uncertain" } as never);
      }

      const result =
        operation === "add"
          ? await h.controller.addTelegramAllowedSender(67890)
          : await h.controller.removeTelegramAllowedSender(67890);

      expect(result).toEqual({ outcome: "uncertain", reason: "storage-uncertain" });
      expect(h.listDesktopAllowedSenders).not.toHaveBeenCalled();
    },
  );

  it.each(["add", "remove"] as const)(
    "returns a closed refusal without projecting sender state after %s is rejected",
    async (operation) => {
      const h = harness({ primary: true });
      h.listDesktopAllowedSenders.mockClear();
      if (operation === "add") {
        h.addSecondarySender.mockReturnValueOnce({
          status: "refused",
          reason: "inconsistent-state",
        });
      } else {
        h.removeSecondarySender.mockReturnValueOnce({
          status: "refused",
          reason: "primary-removal",
        });
      }

      const result =
        operation === "add"
          ? await h.controller.addTelegramAllowedSender(67890)
          : await h.controller.removeTelegramAllowedSender(67890);

      expect(result).toEqual({ outcome: "refused", reason: "invalid-state" });
      expect(h.listDesktopAllowedSenders).not.toHaveBeenCalled();
    },
  );

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
    expect(h.createRuntime).toHaveBeenCalledTimes(2);
    expect(h.runtimes[0]!.start).toHaveBeenCalledOnce();
    expect(h.runtimes[1]!.start).toHaveBeenCalledOnce();
  });

  it("keeps a rejected suspension truthful and resumes the same current runtime", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    h.inputs[0]!.onStarted();
    h.inputs[0]!.onPollingSuccess();
    vi.mocked(h.runtimes[0]!.stop).mockRejectedValueOnce(new Error("synthetic stop failure"));

    await expect(h.controller.stopPolling()).rejects.toThrow(
      "Desktop Telegram runtime release was refused",
    );
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "enabled",
      state: "suspended",
    });
    expect(h.inputs[0]!.admitted()).toBe(false);
    expect(h.createRuntime).toHaveBeenCalledOnce();

    await expect(h.controller.resumePolling()).resolves.toMatchObject({
      channel: { desiredState: "enabled", state: "online" },
    });
    expect(h.inputs[0]!.admitted()).toBe(true);
    expect(h.runtimes[0]!.stop).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.captureDrain).not.toHaveBeenCalled();
    expect(h.createRuntime).toHaveBeenCalledOnce();
  });

  it("serializes polling intent so the last invocation wins", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();

    const resumedThenStopped = [h.controller.resumePolling(), h.controller.stopPolling()];
    await Promise.all(resumedThenStopped);
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "enabled",
      state: "suspended",
    });
    await h.controller.reconcile();
    expect(h.createRuntime).toHaveBeenCalledOnce();
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "enabled",
      state: "suspended",
    });

    const stoppedThenResumed = [h.controller.stopPolling(), h.controller.resumePolling()];
    await Promise.all(stoppedThenResumed);
    expect(h.createRuntime).toHaveBeenCalledTimes(2);
    expect(h.runtimes[0]!.start).toHaveBeenCalledOnce();
    expect(h.runtimes[1]!.start).toHaveBeenCalledOnce();
    expect(h.controller.getStatus().channel).toEqual({
      desiredState: "enabled",
      state: "starting",
    });
  });

  it("captures drain under serialization but waits outside the mutation queue", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    const drainGate = deferred<void>();
    vi.mocked(h.runtimes[0]!.captureDrain).mockReturnValueOnce({
      wait: () => drainGate.promise,
    });
    await h.controller.stopPolling();

    const draining = h.controller.drainPending();
    await settle();
    await expect(h.controller.resumePolling()).resolves.toMatchObject({
      channel: { desiredState: "enabled", state: "starting" },
    });

    let released = false;
    void draining.then(() => {
      released = true;
    });
    await settle();
    expect(released).toBe(false);
    drainGate.resolve();
    await draining;
  });

  it("isolates a fresh resumed runtime from retained old-generation work", async () => {
    const h = harness({ primary: true });
    await h.controller.configure("old-secret-token");
    await h.controller.enable();
    const oldDrainGate = deferred<void>();
    const oldDrainWait = vi.fn(() => oldDrainGate.promise);
    vi.mocked(h.runtimes[0]!.captureDrain).mockReturnValueOnce({ wait: oldDrainWait });

    await h.controller.stopPolling();
    const oldDraining = h.controller.drainPending();
    await vi.waitFor(() => expect(oldDrainWait).toHaveBeenCalledOnce());

    await h.controller.resumePolling();
    expect(h.createRuntime).toHaveBeenCalledTimes(2);
    expect(h.runtimes[0]!.start).toHaveBeenCalledOnce();
    expect(h.runtimes[1]!.start).toHaveBeenCalledOnce();
    h.inputs[1]!.onStarted();
    h.inputs[1]!.onPollingSuccess();
    const resumedStatus = h.controller.getStatus();
    expect(resumedStatus.channel).toMatchObject({ state: "online" });

    h.inputs[0]!.onStarted();
    h.inputs[0]!.onPollingFailure();
    h.inputs[0]!.onPollingSuccess();
    h.starts[0]!.resolve();
    await settle();
    expect(h.controller.getStatus()).toEqual(resumedStatus);

    const newDrainGate = deferred<void>();
    const newDrainWait = vi.fn(() => newDrainGate.promise);
    vi.mocked(h.runtimes[1]!.captureDrain).mockReturnValueOnce({ wait: newDrainWait });
    await h.controller.stopPolling();
    const finalDrain = h.controller.drainPending();
    await vi.waitFor(() => expect(newDrainWait).toHaveBeenCalledOnce());
    expect(oldDrainWait).toHaveBeenCalledOnce();

    let finalReleased = false;
    void finalDrain.then(() => {
      finalReleased = true;
    });
    oldDrainGate.resolve();
    await oldDraining;
    await settle();
    expect(finalReleased).toBe(false);
    newDrainGate.resolve();
    await finalDrain;
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
