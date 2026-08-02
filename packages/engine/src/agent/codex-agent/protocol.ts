import { StringDecoder } from "node:string_decoder";

export const CODEX_METHOD_NOT_FOUND = -32601;
export const CODEX_INTERNAL_ERROR = -32603;

export interface CodexErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface CodexServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export interface CodexNotification {
  readonly method: string;
  readonly params?: unknown;
}

export type CodexServerRequestOutcome =
  | { readonly result: unknown }
  | { readonly error: CodexErrorPayload };

export type CodexProtocolDiagnostic =
  | { readonly kind: "unparseable-line"; readonly bytes: number }
  | { readonly kind: "non-object-line"; readonly bytes: number; readonly jsonType: string }
  | { readonly kind: "unroutable-message"; readonly fields: readonly string[] }
  | {
      readonly kind: "unknown-response-id";
      readonly id: string;
      readonly fields: readonly string[];
    }
  | { readonly kind: "malformed-error-payload"; readonly id: string }
  | { readonly kind: "server-request-handler-failed"; readonly method: string }
  | { readonly kind: "send-failed"; readonly method: string }
  | { readonly kind: "notify-after-exit"; readonly method: string };

export interface CodexProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stderrTail?: string;
}

export class CodexProcessExitError extends Error {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderrTail: string;

  constructor(exit: CodexProcessExit, stderrTail: string) {
    super(codexProcessExitMessage(exit, stderrTail));
    this.name = "CodexProcessExitError";
    this.exitCode = exit.code;
    this.signal = exit.signal;
    this.stderrTail = stderrTail;
  }
}

export class CodexRequestError extends Error {
  readonly code: number;
  readonly method: string;
  readonly data?: unknown;

  constructor(method: string, payload: CodexErrorPayload) {
    super(payload.message);
    this.name = "CodexRequestError";
    this.code = payload.code;
    this.method = method;
    this.data = payload.data;
  }
}

function codexProcessExitMessage(exit: CodexProcessExit, stderrTail: string): string {
  const cause =
    exit.signal !== null && exit.signal !== ""
      ? `signal ${exit.signal}`
      : exit.code !== null
        ? `code ${exit.code}`
        : "an unknown status";
  const base = `Codex app-server exited with ${cause} while a request was in flight.`;
  return stderrTail === "" ? base : `${base} ${stderrTail}`;
}

export interface CodexNotificationCollector extends AsyncIterable<CodexNotification> {
  next(): Promise<IteratorResult<CodexNotification>>;
  readonly done: boolean;
}

class NotificationQueue implements CodexNotificationCollector {
  private readonly buffered: CodexNotification[] = [];
  private readonly waiters: Array<(result: IteratorResult<CodexNotification>) => void> = [];
  private closed = false;

  get done(): boolean {
    return this.closed && this.buffered.length === 0;
  }

  push(notification: CodexNotification): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: notification, done: false });
      return;
    }
    this.buffered.push(notification);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<CodexNotification>> {
    const buffered = this.buffered.shift();
    if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexNotification> {
    return { next: () => this.next() };
  }
}

export interface CodexProtocolClientOptions {
  readonly send: (line: string) => void;
  readonly onServerRequest?: (
    request: CodexServerRequest,
  ) => Promise<CodexServerRequestOutcome> | CodexServerRequestOutcome;
  readonly onDiagnostic?: (diagnostic: CodexProtocolDiagnostic) => void;
  readonly redactStderrTail?: (text: string) => string;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function errorPayloadOf(raw: unknown): CodexErrorPayload | null {
  if (!isPlainObject(raw)) return null;
  const code = raw.code;
  const message = raw.message;
  if (typeof code !== "number" || typeof message !== "string") return null;
  return "data" in raw ? { code, message, data: raw.data } : { code, message };
}

export class CodexProtocolClient {
  private readonly options: CodexProtocolClientOptions;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly queue = new NotificationQueue();
  private readonly decoder = new StringDecoder("utf8");
  private remainder = "";
  private nextId = 1;
  private exit: CodexProcessExit | null = null;
  private exitTail = "";

  constructor(options: CodexProtocolClientOptions) {
    this.options = options;
  }

  get notifications(): CodexNotificationCollector {
    return this.queue;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get terminated(): boolean {
    return this.exit !== null;
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.exit !== null) {
      return Promise.reject(new CodexProcessExitError(this.exit, this.exitTail));
    }
    const id = this.nextId;
    this.nextId += 1;
    const key = String(id);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(key, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        this.options.send(
          this.frame(params === undefined ? { id, method } : { id, method, params }),
        );
      } catch (error) {
        this.pending.delete(key);
        this.options.onDiagnostic?.({ kind: "send-failed", method });
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.exit !== null) {
      this.options.onDiagnostic?.({ kind: "notify-after-exit", method });
      return;
    }
    try {
      this.options.send(this.frame(params === undefined ? { method } : { method, params }));
    } catch {
      this.options.onDiagnostic?.({ kind: "send-failed", method });
    }
  }

  ingest(chunk: string | Uint8Array): void {
    if (this.exit !== null) return;
    const text = typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    if (text === "") return;
    this.remainder += text;
    let newline = this.remainder.indexOf("\n");
    while (newline !== -1) {
      const line = this.remainder.slice(0, newline);
      this.remainder = this.remainder.slice(newline + 1);
      this.handleLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      if (this.exit !== null) return;
      newline = this.remainder.indexOf("\n");
    }
  }

  terminate(exit: CodexProcessExit): void {
    if (this.exit !== null) return;
    const rawTail = exit.stderrTail ?? "";
    const tail = rawTail === "" ? "" : (this.options.redactStderrTail?.(rawTail) ?? rawTail);
    this.exit = exit;
    this.exitTail = tail;
    this.remainder = "";
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      entry.reject(new CodexProcessExitError(exit, tail));
    }
    this.queue.close();
  }

  private frame(message: Record<string, unknown>): string {
    return `${JSON.stringify(message)}\n`;
  }

  private handleLine(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.options.onDiagnostic?.({
        kind: "unparseable-line",
        bytes: Buffer.byteLength(line, "utf8"),
      });
      return;
    }
    if (!isPlainObject(parsed)) {
      this.options.onDiagnostic?.({
        kind: "non-object-line",
        bytes: Buffer.byteLength(line, "utf8"),
        jsonType: jsonTypeOf(parsed),
      });
      return;
    }
    const hasId =
      "id" in parsed && (typeof parsed.id === "number" || typeof parsed.id === "string");
    const method = typeof parsed.method === "string" ? parsed.method : null;
    if (hasId && method !== null) {
      this.handleServerRequest({
        id: parsed.id as number | string,
        method,
        params: parsed.params,
      });
      return;
    }
    if (hasId) {
      this.handleResponse(String(parsed.id), parsed);
      return;
    }
    if (method !== null) {
      this.queue.push({ method, params: parsed.params });
      return;
    }
    this.options.onDiagnostic?.({ kind: "unroutable-message", fields: Object.keys(parsed) });
  }

  private handleResponse(id: string, message: Record<string, unknown>): void {
    const entry = this.pending.get(id);
    if (entry === undefined) {
      this.options.onDiagnostic?.({
        kind: "unknown-response-id",
        id,
        fields: Object.keys(message),
      });
      return;
    }
    this.pending.delete(id);
    if ("error" in message) {
      const payload = errorPayloadOf(message.error);
      if (payload === null) {
        this.options.onDiagnostic?.({ kind: "malformed-error-payload", id });
        entry.reject(
          new CodexRequestError(entry.method, {
            code: CODEX_INTERNAL_ERROR,
            message: `Codex app-server returned a malformed error for ${entry.method}.`,
          }),
        );
        return;
      }
      entry.reject(new CodexRequestError(entry.method, payload));
      return;
    }
    entry.resolve(message.result);
  }

  private handleServerRequest(request: CodexServerRequest): void {
    const handler = this.options.onServerRequest;
    if (handler === undefined) {
      this.respond(request, {
        error: {
          code: CODEX_METHOD_NOT_FOUND,
          message: `Method not found: ${request.method}`,
        },
      });
      return;
    }
    void (async () => {
      let outcome: CodexServerRequestOutcome;
      try {
        outcome = await handler(request);
      } catch {
        this.options.onDiagnostic?.({
          kind: "server-request-handler-failed",
          method: request.method,
        });
        outcome = {
          error: {
            code: CODEX_INTERNAL_ERROR,
            message: `Handler failed for ${request.method}`,
          },
        };
      }
      this.respond(request, outcome);
    })();
  }

  private respond(request: CodexServerRequest, outcome: CodexServerRequestOutcome): void {
    if (this.exit !== null) return;
    const message: Record<string, unknown> =
      "error" in outcome
        ? { id: request.id, error: outcome.error }
        : { id: request.id, result: outcome.result };
    try {
      this.options.send(this.frame(message));
    } catch {
      this.options.onDiagnostic?.({ kind: "send-failed", method: request.method });
    }
  }
}
