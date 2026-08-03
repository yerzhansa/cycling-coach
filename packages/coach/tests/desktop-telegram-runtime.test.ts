import { describe, expect, it, vi } from "vitest";
import type { CreateTelegramChannelInput, TelegramChannelRuntime } from "@enduragent/core";
import { createDesktopTelegramRuntimeFactory } from "../src/desktop-telegram-runtime.js";
import type { InvocationCoordinator } from "../src/daemon/invocation-coordinator.js";
import type { LocalCoachLifecycle } from "../src/local-runner.js";

describe("Desktop Telegram runtime projection", () => {
  it("stays transport-dormant until enabled and projects only daemon-owned capabilities", async () => {
    const channel: TelegramChannelRuntime = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      drainPending: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => undefined),
    };
    const createBot = vi.fn((_input: CreateTelegramChannelInput) => channel);
    const middleware = vi.fn();
    type CreateAccessMiddleware = NonNullable<
      NonNullable<
        Parameters<typeof createDesktopTelegramRuntimeFactory>[1]
      >["createAccessMiddleware"]
    >;
    const createAccessMiddleware = vi.fn<CreateAccessMiddleware>((_input) => middleware);
    const loadAllowedSenders = vi.fn(() => ({ primaryOperator: "73" }));
    const reservation = { run: vi.fn(), cancel: vi.fn(), key: "telegram:73" };
    const reserve = vi.fn(() => reservation);
    const confirmations = {
      peek: vi.fn(() => ({ nonce: "n", summary: "Save plan" })),
      confirm: vi.fn(async () => ({
        status: "executed" as const,
        summary: "Save plan",
        result: {},
      })),
      cancel: vi.fn(() => "canceled" as const),
    };
    const sync = vi.fn(async () => ({
      schemaVersion: 1 as const,
      published: true,
      referenceSucceeded: true,
      requests: { store: 1, reference: 1, total: 2 },
    }));
    const lifecycle = {
      home: { root: "/synthetic/home" },
      engine: {},
      operations: { sync },
      confirmations,
    } as unknown as Pick<LocalCoachLifecycle, "home" | "engine" | "operations" | "confirmations">;
    const invocations = { reserve } as unknown as InvocationCoordinator;

    const runtimeFactory = createDesktopTelegramRuntimeFactory(
      { lifecycle, invocations, appVersion: "1.2.3" },
      {
        createBot,
        createAccessMiddleware,
        loadAllowedSenders: loadAllowedSenders as unknown as NonNullable<
          Parameters<typeof createDesktopTelegramRuntimeFactory>[1]
        >["loadAllowedSenders"],
      },
    );

    expect(createBot).not.toHaveBeenCalled();
    const onStarted = vi.fn();
    const onPollingSuccess = vi.fn();
    const onPollingFailure = vi.fn();
    const consumePairing = vi.fn(async () => true);
    expect(
      runtimeFactory({
        token: "secret",
        onStarted,
        onPollingSuccess,
        onPollingFailure,
        consumePairing,
      }),
    ).toBe(channel);
    expect(createBot).toHaveBeenCalledOnce();
    const projected = createBot.mock.calls[0]![0];
    expect(projected.token).toBe("secret");
    expect(projected.webhookPolicy).toBe("preserve");
    expect(projected.engine).toBe(lifecycle.engine);
    expect(projected.host.diagnostics).toBeUndefined();
    expect(projected.host.access.middleware).toBe(middleware);

    const accessInput = createAccessMiddleware.mock.calls[0]![0];
    expect(accessInput.loadAllowedSenders).toBe(loadAllowedSenders);
    expect(accessInput.consumePairing).toBe(consumePairing);
    expect(accessInput.pairingChallenge!({ senderId: "73", senderName: "Athlete" })).toContain(
      "Desktop → Settings → Telegram",
    );
    expect(await projected.host.authorization.isPrimaryOperator({ senderId: "73" })).toBe(true);
    expect(projected.host.invocations?.reserve("telegram:73")).toBe(reservation);
    expect(reserve).toHaveBeenCalledWith({ key: "telegram:73" });
    await expect(projected.host.confirmations.peek({ chatId: "telegram:73" })).resolves.toEqual({
      nonce: "n",
      summary: "Save plan",
    });
    await expect(projected.host.operations?.sync({ chatId: "telegram:73" })).resolves.toEqual({
      text: "Sync complete — your training data is up to date.",
    });
    expect(sync).toHaveBeenCalledWith({});
    await expect(projected.host.release.version()).resolves.toBe("Cycling Coach Desktop v1.2.3");

    projected.onStart?.();
    projected.onPollingSuccess?.();
    projected.onPollingFailure?.();
    expect(onStarted).toHaveBeenCalledOnce();
    expect(onPollingSuccess).toHaveBeenCalledOnce();
    expect(onPollingFailure).toHaveBeenCalledOnce();
  });
});
