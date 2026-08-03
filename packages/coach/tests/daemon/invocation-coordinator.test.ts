import { describe, expect, it, vi } from "vitest";
import {
  DaemonAdmissionClosedError,
  InvocationReservationSettledError,
  createInvocationCoordinator,
} from "../../src/daemon/invocation-coordinator.js";
import { DetachedSessionRequestError } from "../../src/daemon/session-queue.js";

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

describe("daemon invocation coordinator", () => {
  it("admits work synchronously and rejects new admission after close", async () => {
    const coordinator = createInvocationCoordinator();
    const admitted = coordinator.invoke({ key: "desktop" }, async () => "accepted");

    coordinator.closeAdmission();

    expect(() => coordinator.invoke({ key: "desktop" }, async () => "late")).toThrow(
      DaemonAdmissionClosedError,
    );
    expect(() => coordinator.reserve({ key: "telegram:1" })).toThrow(DaemonAdmissionClosedError);
    await expect(admitted).resolves.toBe("accepted");
  });

  it("lets an open-era reservation run once after admission closes", async () => {
    const coordinator = createInvocationCoordinator();
    const reservation = coordinator.reserve({ key: "telegram:1" });
    const fence = coordinator.closeAdmission();

    const result = reservation.run(async () => "delivered");

    expect(() => reservation.run(async () => "duplicate")).toThrow(
      InvocationReservationSettledError,
    );
    await expect(result).resolves.toBe("delivered");
    await fence.drain();
  });

  it("holds drain for reservations until they run or cancel", async () => {
    const coordinator = createInvocationCoordinator();
    const reservation = coordinator.reserve({ key: "telegram:1" });
    const fence = coordinator.closeAdmission();
    const drained = vi.fn();
    const draining = fence.drain().then(drained);

    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    reservation.cancel();

    await draining;
    expect(drained).toHaveBeenCalledOnce();
    expect(() => reservation.run(async () => "late")).toThrow(InvocationReservationSettledError);
  });

  it("preserves per-key FIFO from reservation time while other keys run independently", async () => {
    const coordinator = createInvocationCoordinator();
    const firstGate = deferred<string>();
    const order: string[] = [];
    const first = coordinator.reserve({ key: "telegram:1" });
    const secondResult = coordinator.invoke({ key: "telegram:1" }, async () => {
      order.push("same-second");
      return "second";
    });
    const otherResult = coordinator.invoke({ key: "desktop" }, async () => {
      order.push("other");
      return "independent";
    });

    expect(order).toEqual(["other"]);
    const firstResult = first.run(() => {
      order.push("same-first");
      return firstGate.promise;
    });
    expect(order).toEqual(["other", "same-first"]);

    firstGate.resolve("first");
    await expect(firstResult).resolves.toBe("first");
    await expect(secondResult).resolves.toBe("second");
    await expect(otherResult).resolves.toBe("independent");
    expect(order).toEqual(["other", "same-first", "same-second"]);
  });

  it("advances a key after rejection", async () => {
    const coordinator = createInvocationCoordinator();
    const failure = new Error("failed");
    const order: string[] = [];
    const first = coordinator.invoke({ key: "desktop" }, async () => {
      order.push("first");
      throw failure;
    });
    const second = coordinator.invoke({ key: "desktop" }, async () => {
      order.push("second");
      return "recovered";
    });

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe("recovered");
    expect(order).toEqual(["first", "second"]);
  });

  it("can reopen admission after a bounded drain attempt times out", async () => {
    const coordinator = createInvocationCoordinator();
    const gate = deferred<void>();
    const running = coordinator.invoke({ key: "desktop" }, () => gate.promise);
    const fence = coordinator.closeAdmission();
    expect(coordinator.closeAdmission()).toBe(fence);
    const draining = fence.drain();

    fence.reopen();
    fence.reopen();
    await expect(coordinator.invoke({ key: "telegram:1" }, async () => "resumed")).resolves.toBe(
      "resumed",
    );

    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve();
    await running;
    await draining;
    expect(drained).toBe(true);
  });

  it("does not let a stale or sealed fence reopen a later admission generation", async () => {
    const coordinator = createInvocationCoordinator();
    const firstFence = coordinator.closeAdmission();
    firstFence.reopen();
    const secondFence = coordinator.closeAdmission();

    firstFence.reopen();
    expect(() => coordinator.invoke({}, async () => "stale")).toThrow(DaemonAdmissionClosedError);

    secondFence.seal();
    secondFence.seal();
    secondFence.reopen();
    expect(() => coordinator.reserve()).toThrow(DaemonAdmissionClosedError);
    await secondFence.drain();
  });

  it("removes queued aborted work and advances the key", async () => {
    const coordinator = createInvocationCoordinator();
    const gate = deferred<void>();
    const first = coordinator.invoke({ key: "desktop" }, () => gate.promise);
    const controller = new AbortController();
    const queuedOperation = vi.fn(async () => "unused");
    const queued = coordinator.invoke(
      { key: "desktop", signal: controller.signal },
      queuedOperation,
    );
    const thirdOperation = vi.fn(async () => "third");
    const third = coordinator.invoke({ key: "desktop" }, thirdOperation);

    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(DetachedSessionRequestError);
    expect(queuedOperation).not.toHaveBeenCalled();
    gate.resolve();
    await first;
    await expect(third).resolves.toBe("third");
    expect(thirdOperation).toHaveBeenCalledOnce();
  });

  it("detaches an aborted running caller but drains the underlying work", async () => {
    const coordinator = createInvocationCoordinator();
    const controller = new AbortController();
    const gate = deferred<string>();
    const result = coordinator.invoke({ signal: controller.signal }, () => gate.promise);
    const fence = coordinator.closeAdmission();
    const drained = vi.fn();
    const draining = fence.drain().then(drained);

    controller.abort();
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    gate.resolve("underlying result");

    await expect(result).rejects.toBeInstanceOf(DetachedSessionRequestError);
    await draining;
    expect(drained).toHaveBeenCalledOnce();
  });

  it("releases an unconsumed aborted reservation and its FIFO position", async () => {
    const coordinator = createInvocationCoordinator();
    const controller = new AbortController();
    const reservation = coordinator.reserve({ key: "telegram:1", signal: controller.signal });
    const followerOperation = vi.fn(async () => "follower");
    const follower = coordinator.invoke({ key: "telegram:1" }, followerOperation);

    expect(followerOperation).not.toHaveBeenCalled();
    controller.abort();

    await expect(follower).resolves.toBe("follower");
    expect(() => reservation.run(async () => "late")).toThrow(DetachedSessionRequestError);
  });
});
