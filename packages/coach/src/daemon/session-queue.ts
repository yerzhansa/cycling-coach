export interface SessionQueueRequest<T> {
  readonly key: string;
  readonly signal: AbortSignal;
  readonly run: () => Promise<T>;
}

export interface SessionRequestQueue {
  run<T>(request: SessionQueueRequest<T>): Promise<T>;
  readonly activeKeyCount: number;
}

export class DetachedSessionRequestError extends Error {
  readonly kind = "detached" as const;

  constructor() {
    super("Session request delivery detached.");
    this.name = "DetachedSessionRequestError";
  }
}

interface QueueNode {
  readonly key: string;
  readonly signal: AbortSignal;
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  previous: QueueNode | undefined;
  next: QueueNode | undefined;
  started: boolean;
  detached: boolean;
}

interface KeyQueue {
  head: QueueNode | undefined;
  tail: QueueNode | undefined;
}

export function createSessionRequestQueue(): SessionRequestQueue {
  const queues = new Map<string, KeyQueue>();

  const removeQueued = (queue: KeyQueue, node: QueueNode): void => {
    if (node.previous === undefined) queue.head = node.next;
    else node.previous.next = node.next;
    if (node.next === undefined) queue.tail = node.previous;
    else node.next.previous = node.previous;
    node.previous = undefined;
    node.next = undefined;
  };

  const start = (queue: KeyQueue, node: QueueNode): void => {
    node.started = true;
    let running: Promise<unknown>;
    try {
      running = node.run();
    } catch (error) {
      running = Promise.reject(error);
    }
    const advance = (): void => {
      node.signal.removeEventListener("abort", node.onAbort);
      if (queue.head === node) removeQueued(queue, node);
      const next = queue.head;
      if (next === undefined) {
        if (queues.get(node.key) === queue) queues.delete(node.key);
        return;
      }
      start(queue, next);
    };
    void running.then(
      (value) => {
        advance();
        if (node.detached) node.reject(new DetachedSessionRequestError());
        else node.resolve(value);
      },
      (error) => {
        advance();
        if (node.detached) node.reject(new DetachedSessionRequestError());
        else node.reject(error);
      },
    );
  };

  return {
    run<T>(request: SessionQueueRequest<T>): Promise<T> {
      if (request.signal.aborted) {
        return Promise.reject(new DetachedSessionRequestError());
      }
      return new Promise<T>((resolve, reject) => {
        const queue = queues.get(request.key) ?? { head: undefined, tail: undefined };
        const node: QueueNode = {
          key: request.key,
          signal: request.signal,
          run: request.run,
          resolve: (value) => resolve(value as T),
          reject,
          onAbort: () => {
            if (node.started) {
              node.detached = true;
              return;
            }
            removeQueued(queue, node);
            request.signal.removeEventListener("abort", node.onAbort);
            reject(new DetachedSessionRequestError());
            if (queue.head === undefined && queues.get(request.key) === queue) {
              queues.delete(request.key);
            }
          },
          previous: queue.tail,
          next: undefined,
          started: false,
          detached: false,
        };
        if (queue.tail === undefined) queue.head = node;
        else queue.tail.next = node;
        queue.tail = node;
        queues.set(request.key, queue);
        request.signal.addEventListener("abort", node.onAbort, { once: true });
        if (queue.head === node) start(queue, node);
      });
    },
    get activeKeyCount(): number {
      return queues.size;
    },
  };
}
