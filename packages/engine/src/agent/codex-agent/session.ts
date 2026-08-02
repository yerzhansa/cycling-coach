import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { buildChildEnv } from "./env.js";
import { binaryMissingError, redactSecretShapes } from "./errors.js";
import {
  CODEX_METHOD_NOT_FOUND,
  CodexProtocolClient,
  type CodexNotification,
  type CodexNotificationCollector,
  type CodexProcessExit,
  type CodexProtocolDiagnostic,
  type CodexServerRequest,
  type CodexServerRequestOutcome,
} from "./protocol.js";

export const CODEX_APP_SERVER_COMMAND = "app-server";
export const CODEX_CLIENT_NAME = "enduragent";
export const CODEX_CLIENT_TITLE = "Enduragent";
export const CODEX_CLIENT_VERSION = "0.0.1";
export const CODEX_HANDSHAKE_TIMEOUT_MS = 25_000;
export const CODEX_CLOSE_GRACE_MS = 2_000;
export const CODEX_STDERR_TAIL_BYTES = 8 * 1024;

export interface CodexBearerBinding {
  readonly envName: string;
  readonly token: string;
}

export type CodexSpawnStdio =
  | readonly ["pipe", "pipe", "pipe"]
  | readonly ["ignore", "pipe", "pipe"];

export interface CodexSpawnOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly shell: false;
  readonly stdio: CodexSpawnStdio;
  readonly windowsHide: true;
}

export interface BuildSpawnOptionsInput {
  readonly binaryPath: string | undefined;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly args?: readonly string[];
  readonly bearer?: CodexBearerBinding;
  readonly stdio?: CodexSpawnStdio;
}

export function buildSpawnOptions(input: BuildSpawnOptionsInput): CodexSpawnOptions {
  const binaryPath = input.binaryPath;
  if (binaryPath === undefined || binaryPath === "") {
    throw new Error("Codex app-server spawn options require an explicit resolved binary path.");
  }

  const bearer = input.bearer;
  const env =
    bearer === undefined
      ? buildChildEnv(input.baseEnv)
      : buildChildEnv(input.baseEnv, {
          bearerEnvName: bearer.envName,
          bearerToken: bearer.token,
        });

  return {
    command: binaryPath,
    args: [...(input.args ?? [])],
    env,
    shell: false,
    stdio: input.stdio ?? ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
}

export function appServerArgs(configArgs: readonly string[] = []): string[] {
  return [CODEX_APP_SERVER_COMMAND, ...configArgs];
}

const AUTO_DENY_PAYLOADS: Readonly<Record<string, () => Record<string, unknown>>> = {
  "item/commandExecution/requestApproval": () => ({ decision: "decline" }),
  "item/fileChange/requestApproval": () => ({ decision: "decline" }),
  "mcpServer/elicitation/request": () => ({ action: "decline", content: null, _meta: null }),
  "item/tool/requestUserInput": () => ({ answers: {} }),
  "item/permissions/requestApproval": () => ({ permissions: {}, scope: "turn" }),
};

export const CODEX_AUTO_DENIED_METHODS: readonly string[] = Object.keys(AUTO_DENY_PAYLOADS);

export function autoDenyServerRequest(request: CodexServerRequest): CodexServerRequestOutcome {
  const payload = AUTO_DENY_PAYLOADS[request.method];
  if (payload === undefined) {
    return {
      error: {
        code: CODEX_METHOD_NOT_FOUND,
        message: `Method not found: ${request.method}`,
      },
    };
  }
  return { result: payload() };
}

const ESCAPE = String.fromCharCode(27);
const BELL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  `${ESCAPE}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BELL}]*${BELL}|[@-Z\\\\-_])`,
  "g",
);
const ERROR_LEVEL_PATTERN = /(?:^|[^A-Za-z])ERROR(?:[^A-Za-z]|$)/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function isErrorLevelLine(line: string): boolean {
  return ERROR_LEVEL_PATTERN.test(line);
}

function truncateToBytes(text: string, capBytes: number): string {
  let out = text;
  let size = Buffer.byteLength(out, "utf8");
  while (size > capBytes) {
    out = out.slice(Math.max(1, size - capBytes));
    size = Buffer.byteLength(out, "utf8");
  }
  return out;
}

export class CodexStderrCollector {
  private readonly capBytes: number;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private retained = "";

  constructor(capBytes: number = CODEX_STDERR_TAIL_BYTES) {
    this.capBytes = capBytes;
  }

  ingest(chunk: string | Uint8Array): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
    if (text === "") return [];
    this.buffer += text;
    const kept: string[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      const accepted = this.accept(line);
      if (accepted !== null) kept.push(accepted);
      newline = this.buffer.indexOf("\n");
    }
    return kept;
  }

  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    const accepted = this.accept(rest);
    return accepted === null ? [] : [accepted];
  }

  tail(): string {
    return this.retained;
  }

  private accept(rawLine: string): string | null {
    const withoutCr = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const line = stripAnsi(withoutCr).trimEnd();
    if (line.trim() === "") return null;
    if (!isErrorLevelLine(line)) return null;
    const redacted = redactSecretShapes(line);
    this.retain(redacted);
    return redacted;
  }

  private retain(line: string): void {
    this.retained = this.retained === "" ? line : `${this.retained}\n${line}`;
    while (Buffer.byteLength(this.retained, "utf8") > this.capBytes) {
      const newline = this.retained.indexOf("\n");
      if (newline === -1) {
        this.retained = truncateToBytes(this.retained, this.capBytes);
        return;
      }
      this.retained = this.retained.slice(newline + 1);
    }
  }
}

class NotificationSubscriber implements CodexNotificationCollector {
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

export class CodexNotificationFanOut {
  private readonly subscribers = new Set<NotificationSubscriber>();
  private readonly backlog: CodexNotification[] = [];
  private closed = false;

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  push(notification: CodexNotification): void {
    if (this.closed) return;
    if (this.subscribers.size === 0) {
      this.backlog.push(notification);
      return;
    }
    for (const subscriber of this.subscribers) subscriber.push(notification);
  }

  subscribe(): CodexNotificationCollector {
    const subscriber = new NotificationSubscriber();
    if (this.subscribers.size === 0) {
      while (this.backlog.length > 0) {
        const pending = this.backlog.shift();
        if (pending !== undefined) subscriber.push(pending);
      }
    }
    this.subscribers.add(subscriber);
    if (this.closed) subscriber.close();
    return subscriber;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.backlog.length = 0;
    for (const subscriber of this.subscribers) subscriber.close();
  }
}

export interface CodexInitializeResponse {
  readonly userAgent?: string;
  readonly codexHome?: string;
  readonly platformFamily?: string;
  readonly platformOs?: string;
}

export interface CodexAppServerSession {
  readonly client: CodexProtocolClient;
  readonly spawnOptions: CodexSpawnOptions;
  readonly userAgent: string;
  readonly initializeResponse: CodexInitializeResponse;
  notifications(): CodexNotificationCollector;
  stderrTail(): string;
  exitStatus(): CodexProcessExit | null;
  exited(): Promise<CodexProcessExit>;
  close(): Promise<void>;
}

export interface StartAppServerInput {
  readonly binaryPath: string;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly configArgs?: readonly string[];
  readonly bearer?: CodexBearerBinding;
  readonly clientVersion?: string;
  readonly optOutNotificationMethods?: readonly string[];
  readonly handshakeTimeoutMs?: number;
  readonly closeGraceMs?: number;
  readonly stderrTailBytes?: number;
  readonly onDiagnostic?: (diagnostic: CodexProtocolDiagnostic) => void;
  readonly onStderrLine?: (line: string) => void;
  readonly spawnProcess?: (options: CodexSpawnOptions) => ChildProcess;
}

function defaultSpawn(options: CodexSpawnOptions): ChildProcess {
  return nodeSpawn(options.command, [...options.args], {
    env: options.env,
    shell: options.shell,
    stdio: [...options.stdio],
    windowsHide: options.windowsHide,
  });
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeoutError(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function endStdin(child: ChildProcess): void {
  try {
    child.stdin?.end();
  } catch {
    child.stdin?.destroy();
  }
}

export async function startAppServer(input: StartAppServerInput): Promise<CodexAppServerSession> {
  const spawnOptions = buildSpawnOptions({
    binaryPath: input.binaryPath,
    baseEnv: input.baseEnv,
    args: appServerArgs(input.configArgs),
    bearer: input.bearer,
  });

  const launch = input.spawnProcess ?? defaultSpawn;
  const child = launch(spawnOptions);
  const stderr = new CodexStderrCollector(input.stderrTailBytes ?? CODEX_STDERR_TAIL_BYTES);
  const fanOut = new CodexNotificationFanOut();
  const closeGraceMs = input.closeGraceMs ?? CODEX_CLOSE_GRACE_MS;

  let exit: CodexProcessExit | null = null;
  let spawnFailure: Error | null = null;
  let closePromise: Promise<void> | null = null;

  const client = new CodexProtocolClient({
    send: (line) => {
      child.stdin?.write(line);
    },
    onServerRequest: autoDenyServerRequest,
    onDiagnostic: input.onDiagnostic,
    redactStderrTail: redactSecretShapes,
  });

  void (async () => {
    for await (const notification of client.notifications) fanOut.push(notification);
    fanOut.close();
  })();

  child.stdout?.on("data", (chunk: Buffer) => client.ingest(chunk));
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of stderr.ingest(chunk)) input.onStderrLine?.(line);
  });

  const exited = new Promise<CodexProcessExit>((resolve) => {
    child.on("close", (code, signal) => {
      for (const line of stderr.flush()) input.onStderrLine?.(line);
      const status: CodexProcessExit = { code, signal, stderrTail: stderr.tail() };
      exit = status;
      client.terminate(status);
      resolve(status);
    });
  });

  child.on("error", (error: NodeJS.ErrnoException) => {
    spawnFailure =
      error.code === "ENOENT" ? binaryMissingError(spawnOptions.command) : (error as Error);
  });

  const raceExit = async (waitMs: number): Promise<boolean> => {
    if (exit !== null) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    return waited;
  };

  const close = (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    closePromise = (async () => {
      if (exit === null) {
        endStdin(child);
        const graceful = await raceExit(closeGraceMs);
        if (!graceful) {
          child.kill("SIGKILL");
          await raceExit(closeGraceMs);
        }
      }
      fanOut.close();
    })();
    return closePromise;
  };

  let initializeResponse: CodexInitializeResponse;
  try {
    initializeResponse = await withTimeout(
      client.request<CodexInitializeResponse>("initialize", {
        clientInfo: {
          name: CODEX_CLIENT_NAME,
          title: CODEX_CLIENT_TITLE,
          version: input.clientVersion ?? CODEX_CLIENT_VERSION,
        },
        capabilities: buildCapabilities(input.optOutNotificationMethods),
      }),
      input.handshakeTimeoutMs ?? CODEX_HANDSHAKE_TIMEOUT_MS,
      `Codex app-server did not answer initialize within ${input.handshakeTimeoutMs ?? CODEX_HANDSHAKE_TIMEOUT_MS}ms.`,
    );
  } catch (error) {
    await close();
    throw spawnFailure ?? error;
  }

  client.notify("initialized");

  return {
    client,
    spawnOptions,
    userAgent: typeof initializeResponse.userAgent === "string" ? initializeResponse.userAgent : "",
    initializeResponse,
    notifications: () => fanOut.subscribe(),
    stderrTail: () => stderr.tail(),
    exitStatus: () => exit,
    exited: () => exited,
    close,
  };
}

export interface CodexClientCapabilities {
  readonly experimentalApi: false;
  readonly requestAttestation: false;
  readonly optOutNotificationMethods?: readonly string[];
}

export function buildCapabilities(
  optOutNotificationMethods?: readonly string[],
): CodexClientCapabilities {
  if (optOutNotificationMethods === undefined || optOutNotificationMethods.length === 0) {
    return { experimentalApi: false, requestAttestation: false };
  }
  return {
    experimentalApi: false,
    requestAttestation: false,
    optOutNotificationMethods: [...optOutNotificationMethods],
  };
}
