import { DetachedSessionRequestError } from "./session-queue.js";

export interface InvocationInput {
  readonly key?: string;
  readonly signal?: AbortSignal;
}

export interface InvocationReservation {
  readonly key: string | undefined;
  run<T>(operation: () => Promise<T>): Promise<T>;
  cancel(): void;
}

export interface AdmissionFence {
  drain(): Promise<void>;
  reopen(): boolean;
  seal(): void;
}

export interface InvocationCoordinator {
  canAdmit(): boolean;
  reserve(input?: InvocationInput): InvocationReservation;
  invoke<T>(input: InvocationInput, operation: () => Promise<T>): Promise<T>;
  closeAdmission(): AdmissionFence;
}

export class DaemonAdmissionClosedError extends Error {
  readonly kind = "daemon_admission_closed" as const;

  constructor() {
    super("Daemon invocation admission is closed.");
    this.name = "DaemonAdmissionClosedError";
  }
}

export class InvocationReservationSettledError extends Error {
  readonly kind = "invocation_reservation_settled" as const;

  constructor() {
    super("Invocation reservation has already been used or cancelled.");
    this.name = "InvocationReservationSettledError";
  }
}

type NodeState = "reserved" | "ready" | "running" | "settled" | "cancelled";

interface InvocationNode {
  readonly key: string | undefined;
  readonly signal: AbortSignal | undefined;
  state: NodeState;
  operation: (() => Promise<unknown>) | undefined;
  resolve: ((value: unknown) => void) | undefined;
  reject: ((error: unknown) => void) | undefined;
  terminalError: unknown;
  detached: boolean;
  onAbort: (() => void) | undefined;
  queue: KeyQueue | undefined;
  previous: InvocationNode | undefined;
  next: InvocationNode | undefined;
}

interface KeyQueue {
  readonly key: string;
  head: InvocationNode | undefined;
  tail: InvocationNode | undefined;
}

interface FenceRecord extends AdmissionFence {
  readonly generation: number;
  readonly pending: Set<InvocationNode>;
  readonly waiters: Set<() => void>;
  sealed: boolean;
}

function createNode(input: InvocationInput, state: NodeState): InvocationNode {
  return {
    key: input.key,
    signal: input.signal,
    state,
    operation: undefined,
    resolve: undefined,
    reject: undefined,
    terminalError: undefined,
    detached: false,
    onAbort: undefined,
    queue: undefined,
    previous: undefined,
    next: undefined,
  };
}

export function createInvocationCoordinator(): InvocationCoordinator {
  const queues = new Map<string, KeyQueue>();
  const outstanding = new Set<InvocationNode>();
  const activeFences = new Set<FenceRecord>();
  let admissionOpen = true;
  let generation = 0;
  let currentFence: FenceRecord | undefined;

  const assertAdmissionOpen = (): void => {
    if (!admissionOpen) throw new DaemonAdmissionClosedError();
  };

  const assertSignalAttached = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted === true) throw new DetachedSessionRequestError();
  };

  const notifyFences = (node: InvocationNode): void => {
    for (const fence of activeFences) {
      if (!fence.pending.delete(node) || fence.pending.size > 0) continue;
      activeFences.delete(fence);
      for (const resolve of fence.waiters) resolve();
      fence.waiters.clear();
    }
  };

  const removeFromQueue = (node: InvocationNode): KeyQueue | undefined => {
    const queue = node.queue;
    if (queue === undefined) return undefined;
    if (node.previous === undefined) queue.head = node.next;
    else node.previous.next = node.next;
    if (node.next === undefined) queue.tail = node.previous;
    else node.next.previous = node.previous;
    node.queue = undefined;
    node.previous = undefined;
    node.next = undefined;
    if (queue.head === undefined && queues.get(queue.key) === queue) queues.delete(queue.key);
    return queue;
  };

  const removeAbortListener = (node: InvocationNode): void => {
    if (node.signal !== undefined && node.onAbort !== undefined) {
      node.signal.removeEventListener("abort", node.onAbort);
      node.onAbort = undefined;
    }
  };

  let pumpQueue: (queue: KeyQueue) => void;

  const releaseNode = (node: InvocationNode): void => {
    const queue = removeFromQueue(node);
    outstanding.delete(node);
    notifyFences(node);
    if (queue !== undefined) pumpQueue(queue);
  };

  const cancelQueuedNode = (node: InvocationNode, error: unknown): void => {
    if (node.state !== "reserved" && node.state !== "ready") return;
    node.state = "cancelled";
    node.terminalError = error;
    removeAbortListener(node);
    releaseNode(node);
    node.reject?.(error);
  };

  const finishRunningNode = (
    node: InvocationNode,
    outcome:
      | { readonly ok: true; readonly value: unknown }
      | { readonly ok: false; readonly error: unknown },
  ): void => {
    if (node.state !== "running") return;
    node.state = "settled";
    removeAbortListener(node);
    releaseNode(node);
    if (node.detached) {
      node.reject?.(new DetachedSessionRequestError());
    } else if (outcome.ok) {
      node.resolve?.(outcome.value);
    } else {
      node.reject?.(outcome.error);
    }
  };

  const startNode = (node: InvocationNode): void => {
    if (node.state !== "ready" || node.operation === undefined) return;
    node.state = "running";
    let running: Promise<unknown>;
    try {
      running = Promise.resolve(node.operation());
    } catch (error) {
      running = Promise.reject(error);
    }
    void running.then(
      (value) => finishRunningNode(node, { ok: true, value }),
      (error: unknown) => finishRunningNode(node, { ok: false, error }),
    );
  };

  pumpQueue = (queue): void => {
    const head = queue.head;
    if (head === undefined || head.state === "reserved" || head.state === "running") return;
    if (head.state === "ready") {
      startNode(head);
      return;
    }
    removeFromQueue(head);
    pumpQueue(queue);
  };

  const attachAbort = (node: InvocationNode): void => {
    if (node.signal === undefined) return;
    node.onAbort = () => {
      if (node.state === "running") {
        node.detached = true;
        return;
      }
      cancelQueuedNode(node, new DetachedSessionRequestError());
    };
    node.signal.addEventListener("abort", node.onAbort, { once: true });
  };

  const enqueue = (node: InvocationNode): void => {
    outstanding.add(node);
    attachAbort(node);
    if (node.key === undefined) {
      if (node.state === "ready") startNode(node);
      return;
    }
    const queue = queues.get(node.key) ?? {
      key: node.key,
      head: undefined,
      tail: undefined,
    };
    node.queue = queue;
    node.previous = queue.tail;
    if (queue.tail === undefined) queue.head = node;
    else queue.tail.next = node;
    queue.tail = node;
    queues.set(node.key, queue);
    pumpQueue(queue);
  };

  const prepareRun = <T>(node: InvocationNode, operation: () => Promise<T>): Promise<T> => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    node.operation = operation;
    node.resolve = (value) => resolve(value as T);
    node.reject = reject;
    node.state = "ready";
    if (node.key === undefined) startNode(node);
    else if (node.queue !== undefined) pumpQueue(node.queue);
    return result;
  };

  const reserve = (input: InvocationInput = {}): InvocationReservation => {
    assertAdmissionOpen();
    assertSignalAttached(input.signal);
    const node = createNode(input, "reserved");
    enqueue(node);
    return {
      key: node.key,
      run<T>(operation: () => Promise<T>): Promise<T> {
        if (
          node.state === "cancelled" &&
          node.terminalError instanceof DetachedSessionRequestError
        ) {
          throw node.terminalError;
        }
        if (node.state !== "reserved") throw new InvocationReservationSettledError();
        return prepareRun(node, operation);
      },
      cancel(): void {
        if (node.state !== "reserved") throw new InvocationReservationSettledError();
        cancelQueuedNode(node, new InvocationReservationSettledError());
      },
    };
  };

  return {
    canAdmit() {
      return admissionOpen;
    },
    reserve,
    invoke<T>(input: InvocationInput, operation: () => Promise<T>): Promise<T> {
      assertAdmissionOpen();
      assertSignalAttached(input.signal);
      const node = createNode(input, "ready");
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const result = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      node.operation = operation;
      node.resolve = (value) => resolve(value as T);
      node.reject = reject;
      enqueue(node);
      return result;
    },
    closeAdmission(): AdmissionFence {
      if (!admissionOpen && currentFence !== undefined) return currentFence;
      admissionOpen = false;
      generation += 1;
      let fence!: FenceRecord;
      fence = {
        generation,
        pending: new Set(outstanding),
        waiters: new Set(),
        sealed: false,
        drain(): Promise<void> {
          if (fence.pending.size === 0) return Promise.resolve();
          return new Promise<void>((resolve) => fence.waiters.add(resolve));
        },
        reopen(): boolean {
          if (
            fence.sealed ||
            currentFence?.generation !== fence.generation ||
            currentFence !== fence
          ) {
            return false;
          }
          admissionOpen = true;
          currentFence = undefined;
          return true;
        },
        seal(): void {
          fence.sealed = true;
        },
      };
      currentFence = fence;
      if (fence.pending.size > 0) activeFences.add(fence);
      return fence;
    },
  };
}
