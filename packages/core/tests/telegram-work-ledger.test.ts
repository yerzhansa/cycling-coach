import { describe, expect, it } from "vitest";
import {
  TelegramDirectSendSealedError,
  TelegramWorkLedger,
} from "../src/channels/telegram-work-ledger.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("TelegramWorkLedger", () => {
  it("returns the admitted promise unchanged and keeps the generation non-quiescent until it settles", async () => {
    const ledger = new TelegramWorkLedger();
    const work = deferred<string>();

    const admitted = ledger.track(() => work.promise);
    expect(admitted).toBe(work.promise);

    ledger.sealCurrentGeneration();
    ledger.markCurrentGenerationStopped();
    let drained = false;
    const draining = ledger
      .captureSealedGenerations()
      .wait()
      .then(() => {
        drained = true;
      });
    await Promise.resolve();
    expect(drained).toBe(false);

    work.resolve("done");
    await draining;
    expect(drained).toBe(true);
  });

  it("admits work before invoking it so a reentrant drain cannot miss the promise", async () => {
    const ledger = new TelegramWorkLedger();
    const work = deferred<void>();
    ledger.sealCurrentGeneration();
    ledger.markCurrentGenerationStopped();
    let reentrantDrain!: Promise<void>;
    let drained = false;

    ledger.track(() => {
      reentrantDrain = ledger
        .captureSealedGenerations()
        .wait()
        .then(() => {
          drained = true;
        });
      return work.promise;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    work.resolve();
    await reentrantDrain;
    expect(drained).toBe(true);
  });

  it("refuses a direct send after sealing without invoking its operation", async () => {
    const ledger = new TelegramWorkLedger();
    ledger.sealCurrentGeneration();
    let called = false;

    await expect(
      ledger.trackDirectSend(async () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(TelegramDirectSendSealedError);
    expect(called).toBe(false);
  });

  it("keeps a sealed snapshot isolated from a later polling generation", async () => {
    const ledger = new TelegramWorkLedger();
    const oldWork = deferred<void>();
    ledger.track(() => oldWork.promise);
    ledger.sealCurrentGeneration();
    ledger.markCurrentGenerationStopped();
    const oldSnapshot = ledger.captureSealedGenerations();

    const newWork = deferred<void>();
    ledger.startGeneration(() => newWork.promise);
    let oldDrained = false;
    const drainingOld = oldSnapshot.wait().then(() => {
      oldDrained = true;
    });

    oldWork.resolve();
    await drainingOld;
    expect(oldDrained).toBe(true);

    let newSettled = false;
    void newWork.promise.then(() => {
      newSettled = true;
    });
    await Promise.resolve();
    expect(newSettled).toBe(false);
    newWork.resolve();
  });

  it("a later final snapshot retains unfinished work from every sealed generation", async () => {
    const ledger = new TelegramWorkLedger();
    const oldWork = deferred<void>();
    ledger.track(() => oldWork.promise);
    ledger.sealCurrentGeneration();
    ledger.markCurrentGenerationStopped();

    ledger.startGeneration(async () => undefined);
    ledger.sealCurrentGeneration();
    ledger.markCurrentGenerationStopped();
    let drained = false;
    const draining = ledger
      .captureSealedGenerations()
      .wait()
      .then(() => {
        drained = true;
      });
    await Promise.resolve();
    expect(drained).toBe(false);

    oldWork.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it("rechecks the captured generation for work spawned while another entry settles", async () => {
    const ledger = new TelegramWorkLedger();
    const first = deferred<void>();
    const second = deferred<void>();
    ledger.track(async () => {
      await first.promise;
      ledger.track(() => second.promise);
    });
    ledger.sealCurrentGeneration();
    ledger.markCurrentGenerationStopped();
    let drained = false;
    const draining = ledger
      .captureSealedGenerations()
      .wait()
      .then(() => {
        drained = true;
      });

    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(drained).toBe(false);
    second.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it("attributes a late root update to the polling scope that delivered it", async () => {
    const ledger = new TelegramWorkLedger();
    const oldScope = ledger.currentScope();
    ledger.sealCurrentGeneration();
    ledger.markCurrentGenerationStopped();
    const oldSnapshot = ledger.captureSealedGenerations();
    ledger.startGeneration(async () => undefined);

    const lateUpdate = deferred<void>();
    ledger.runInScope(oldScope, () => ledger.trackUpdate(() => lateUpdate.promise));
    let drained = false;
    const draining = oldSnapshot.wait().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    lateUpdate.resolve();
    await draining;
    expect(drained).toBe(true);
  });

  it("releases completed sealed generations after their snapshot is fully drained", async () => {
    const ledger = new TelegramWorkLedger();
    const releasedScope = ledger.currentScope();
    ledger.sealCurrentGeneration();
    ledger.markCurrentGenerationStopped();
    const released = ledger.captureSealedGenerations();
    await released.wait();
    released.release();

    ledger.startGeneration(async () => undefined);
    ledger.sealCurrentGeneration();
    ledger.markCurrentGenerationStopped();
    const next = ledger.captureSealedGenerations();
    expect(next.includes(releasedScope)).toBe(false);
  });
});
