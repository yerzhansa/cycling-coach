import { AsyncLocalStorage } from "node:async_hooks";

interface WorkGeneration {
  readonly work: Set<Promise<void>>;
  sealed: boolean;
  stopped: boolean;
}

export type TelegramWorkScope = WorkGeneration;

export interface TelegramWorkLedgerSnapshot {
  includes(scope: TelegramWorkScope): boolean;
  wait(): Promise<void>;
  release(): void;
}

export class TelegramDirectSendSealedError extends Error {
  readonly code = "telegram-generation-sealed";

  constructor() {
    super("Telegram generation no longer admits direct sends");
    this.name = "TelegramDirectSendSealedError";
  }
}

function createGeneration(): WorkGeneration {
  return { work: new Set(), sealed: false, stopped: false };
}

async function waitForGenerations(generations: readonly WorkGeneration[]): Promise<void> {
  while (true) {
    const pending = generations.flatMap((generation) => [...generation.work]);
    if (pending.length === 0) return;
    await Promise.all(pending);
  }
}

export class TelegramWorkLedger {
  readonly #context = new AsyncLocalStorage<WorkGeneration>();
  readonly #generations = new Set<WorkGeneration>();
  #current = createGeneration();

  constructor() {
    this.#generations.add(this.#current);
  }

  currentScope(): TelegramWorkScope {
    return this.#context.getStore() ?? this.#current;
  }

  runInScope<T>(scope: TelegramWorkScope, operation: () => T): T {
    return this.#context.run(scope, operation);
  }

  track<T>(operation: () => Promise<T>, scope = this.currentScope()): Promise<T> {
    let markSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    scope.work.add(settled);
    void settled.then(() => scope.work.delete(settled));
    let result: Promise<T>;
    try {
      result = this.runInScope(scope, operation);
    } catch (error) {
      markSettled();
      throw error;
    }
    void result.then(markSettled, markSettled);
    return result;
  }

  trackUpdate<T>(operation: () => Promise<T>): Promise<T> {
    return this.track(operation, this.currentScope());
  }

  trackDirectSend<T>(operation: () => Promise<T>): Promise<T> {
    const scope = this.#current;
    if (scope.sealed) return Promise.reject(new TelegramDirectSendSealedError());
    return this.track(operation, scope);
  }

  startGeneration<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#current.sealed) {
      this.#current = createGeneration();
      this.#generations.add(this.#current);
    }
    return this.track(operation, this.#current);
  }

  sealCurrentGeneration(): TelegramWorkScope {
    this.#current.sealed = true;
    return this.#current;
  }

  markCurrentGenerationStopped(): void {
    this.#current.stopped = true;
  }

  stopCurrentGeneration<T>(operation: () => Promise<T>): Promise<T> {
    const scope = this.sealCurrentGeneration();
    const result = this.track(operation, scope);
    void result.then(
      () => {
        scope.stopped = true;
      },
      () => undefined,
    );
    return result;
  }

  captureSealedGenerations(): TelegramWorkLedgerSnapshot {
    if (!this.#current.sealed || !this.#current.stopped) {
      throw new Error("Telegram polling must stop before its generation can be drained");
    }
    return this.capture([...this.#generations].filter((generation) => generation.sealed));
  }

  captureAllGenerations(): TelegramWorkLedgerSnapshot {
    return this.capture([...this.#generations]);
  }

  private capture(generations: readonly WorkGeneration[]): TelegramWorkLedgerSnapshot {
    const included = new Set(generations);
    return {
      includes: (scope) => included.has(scope),
      wait: () => waitForGenerations(generations),
      release: () => {
        for (const generation of generations) {
          if (generation.sealed && generation.stopped && generation.work.size === 0) {
            this.#generations.delete(generation);
          }
        }
      },
    };
  }
}
