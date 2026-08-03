import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type {
  CoachEngine,
  CoachOperations,
  SpendOperations,
  OperationProgressEvent,
  TelegramControlSnapshot,
  TurnEvent,
} from "@enduragent/coach-contract";
import { acquireWriteLock } from "../../../../packages/kernel-node/src/lock/index.js";
import { createHealthzRequestHandler } from "../../../../packages/coach/src/daemon/healthz-server.js";
import { createCoachRpcServer } from "../../../../packages/coach/src/daemon/rpc-server.js";
import type { DesktopTelegramController } from "../../../../packages/coach/src/desktop-telegram-controller.js";

export interface DesktopFixtureScript {
  readonly onRequest: (request: unknown) => readonly string[] | Promise<readonly string[]>;
}

export interface RunningDesktopFixture {
  evaluate<T>(source: string): Promise<T>;
  screenshot(path: string): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  readCapturedSurface(name: "location" | "console" | "stdout" | "stderr" | "dom"): string;
  close(): Promise<{
    readonly livePids: readonly number[];
    readonly listenerCount: number;
  }>;
}

interface CdpResponse {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly message?: string };
}

interface ScriptRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: unknown;
}

const require = createRequire(import.meta.url);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const disabledTelegramSnapshot: TelegramControlSnapshot = {
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
};
const disabledTelegram: DesktopTelegramController = {
  getStatus: () => disabledTelegramSnapshot,
  configure: async () => disabledTelegramSnapshot,
  enable: async () => disabledTelegramSnapshot,
  disable: async () => disabledTelegramSnapshot,
  replace: async () => disabledTelegramSnapshot,
  reconcile: async () => disabledTelegramSnapshot,
  inspectTelegramCredential: async () => ({
    status: "unavailable",
    errorCode: "telegram-validation-failed",
  }),
  deleteTelegramWebhook: async () => ({
    status: "unavailable",
    errorCode: "telegram-validation-failed",
  }),
  forgetTelegramCredential: async () => disabledTelegramSnapshot,
  resetTelegramAccess: async () => disabledTelegramSnapshot,
  beginTelegramPairing: async () => disabledTelegramSnapshot,
  cancelTelegramPairing: async () => disabledTelegramSnapshot,
  listTelegramAllowedSenders: async () => ({ senders: [] }),
  addTelegramAllowedSender: async () => ({ senders: [] }),
  removeTelegramAllowedSender: async () => ({ senders: [] }),
  stopPolling: async () => disabledTelegramSnapshot,
  resumePolling: async () => disabledTelegramSnapshot,
  drainPending: async () => disabledTelegramSnapshot,
  close: async () => disabledTelegramSnapshot,
};

function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new TypeError("loopback port was not assigned"));
        return;
      }
      server.close((error) => (error === undefined ? resolvePort(address.port) : reject(error)));
    });
  });
}

function parseScriptFrames(values: readonly string[]): readonly unknown[] {
  return values.map((value) => JSON.parse(value) as unknown);
}

function frameValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if ("result" in record) return record.result;
  }
  return value;
}

function frameEvent(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.params !== null && typeof record.params === "object") {
      const event = (record.params as Record<string, unknown>).event;
      if (event !== undefined) return event;
    }
    if (record.event !== undefined) return record.event;
  }
  return value;
}

async function scripted(
  script: DesktopFixtureScript,
  method: string,
  params: unknown,
): Promise<readonly unknown[]> {
  const request: ScriptRequest = { jsonrpc: "2.0", method, params };
  return parseScriptFrames(await script.onRequest(request));
}

function finalFrame(frames: readonly unknown[]): unknown {
  const value = frames.at(-1);
  if (value === undefined) throw new TypeError("fixture script returned no terminal frame");
  return frameValue(value);
}

function eventFrames(frames: readonly unknown[]): readonly unknown[] {
  return frames.length < 2 ? [] : frames.slice(0, -1).map(frameEvent);
}

async function waitForPage(port: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const entries = (await response.json()) as readonly {
          readonly type?: unknown;
          readonly url?: unknown;
          readonly webSocketDebuggerUrl?: unknown;
        }[];
        const page = entries.find(
          (entry) =>
            entry.type === "page" &&
            typeof entry.url === "string" &&
            entry.url.startsWith("enduragent://app/") &&
            typeof entry.webSocketDebuggerUrl === "string",
        );
        if (page !== undefined) return page.webSocketDebuggerUrl as string;
      }
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("timed out waiting for the desktop renderer");
}

function connectCdp(
  url: string,
  onEvent: (message: CdpResponse) => void,
): Promise<{
  readonly socket: WebSocket;
  call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}> {
  return new Promise((resolveConnection, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map<
      number,
      {
        readonly resolve: (value: Record<string, unknown>) => void;
        readonly reject: (error: Error) => void;
      }
    >();
    let sequence = 0;
    socket.addEventListener(
      "error",
      () => reject(new Error("desktop debugger connection failed")),
      { once: true },
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpResponse;
      if (message.id === undefined) {
        onEvent(message);
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter === undefined) return;
      pending.delete(message.id);
      if (message.error !== undefined) {
        waiter.reject(new Error(message.error.message ?? "desktop debugger command failed"));
      } else {
        waiter.resolve(message.result ?? {});
      }
    });
    socket.addEventListener("close", () => {
      for (const waiter of pending.values())
        waiter.reject(new Error("desktop debugger disconnected"));
      pending.clear();
    });
    socket.addEventListener(
      "open",
      () => {
        resolveConnection({
          socket,
          call(method, params = {}) {
            const id = ++sequence;
            return new Promise((resolveCall, rejectCall) => {
              pending.set(id, { resolve: resolveCall, reject: rejectCall });
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
        });
      },
      { once: true },
    );
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), 5_000)),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  }
}

export async function launchDesktopFixture(input: {
  readonly script: DesktopFixtureScript;
  readonly token: string;
  readonly width: number;
  readonly height: number;
  readonly colorScheme: "light" | "dark";
  readonly reducedMotion: boolean;
}): Promise<RunningDesktopFixture> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(input.token)) throw new TypeError("invalid fixture token");
  if (!existsSync(join(desktopRoot, "out/main/index.js"))) {
    throw new Error("desktop build output is required before launching the fixture");
  }
  const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
  const scratch = await mkdtemp(join(base, "eap-"));
  const athleteHome = join(scratch, "h");
  const configDir = join(athleteHome, "config");
  const userData = join(scratch, "u");
  await Promise.all([
    mkdir(configDir, { recursive: true, mode: 0o700 }),
    mkdir(userData, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(join(configDir, "daemon.token"), `${input.token}\n`, { mode: 0o600 }),
    writeFile(
      join(configDir, "config.yaml"),
      [
        "data_source: store",
        `data_dir: ${JSON.stringify(athleteHome)}`,
        "llm:",
        "  provider: anthropic",
        "  model: fixture",
        "  api_key: fixture",
        "intervals:",
        "  api_key: ''",
        "  athlete_id: '0'",
        "session:",
        "  timezone: UTC",
        "",
      ].join("\n"),
      { mode: 0o600 },
    ),
  ]);
  const lock = await acquireWriteLock({
    configDir,
    athleteHome,
    version: "0.0.1",
  });
  if (lock.status !== "acquired") throw new Error("fixture writer lock was not acquired");
  const invoke = (method: string, params: unknown) => scripted(input.script, method, params);
  const engine: CoachEngine = {
    async chat(request, onEvent) {
      const frames = await invoke("chat", request);
      for (const event of eventFrames(frames)) {
        onEvent?.(event as TurnEvent);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));
      }
      return finalFrame(frames) as Awaited<ReturnType<CoachEngine["chat"]>>;
    },
    async resetSession(request) {
      return finalFrame(await invoke("resetSession", request)) as Awaited<
        ReturnType<CoachEngine["resetSession"]>
      >;
    },
    async hasSession(request) {
      return finalFrame(await invoke("hasSession", request)) as Awaited<
        ReturnType<CoachEngine["hasSession"]>
      >;
    },
    async getAthleteState() {
      return finalFrame(await invoke("getAthleteState", {})) as Awaited<
        ReturnType<CoachEngine["getAthleteState"]>
      >;
    },
  };
  const operations: CoachOperations = {
    async importFiles(request, onEvent) {
      const frames = await invoke("importFiles", request);
      for (const event of eventFrames(frames)) onEvent?.(event as OperationProgressEvent);
      return finalFrame(frames) as Awaited<ReturnType<CoachOperations["importFiles"]>>;
    },
    async sync(request, onEvent) {
      const frames = await invoke("sync", request);
      for (const event of eventFrames(frames)) onEvent?.(event as OperationProgressEvent);
      return finalFrame(frames) as Awaited<ReturnType<CoachOperations["sync"]>>;
    },
    async saveIntake(request) {
      return finalFrame(await invoke("saveIntake", request)) as Awaited<
        ReturnType<CoachOperations["saveIntake"]>
      >;
    },
    async getTranscriptPage(request) {
      return finalFrame(await invoke("getTranscriptPage", request)) as Awaited<
        ReturnType<CoachOperations["getTranscriptPage"]>
      >;
    },
    async listArchivedConversations(request) {
      return finalFrame(await invoke("listArchivedConversations", request)) as Awaited<
        ReturnType<CoachOperations["listArchivedConversations"]>
      >;
    },
    async getArchivedTranscriptPage(request) {
      return finalFrame(await invoke("getArchivedTranscriptPage", request)) as Awaited<
        ReturnType<CoachOperations["getArchivedTranscriptPage"]>
      >;
    },
    async configureRuntime(request) {
      return finalFrame(await invoke("configureRuntime", request)) as Awaited<
        ReturnType<CoachOperations["configureRuntime"]>
      >;
    },
    async getRuntimeConfig(request) {
      return finalFrame(await invoke("getRuntimeConfig", request)) as Awaited<
        ReturnType<CoachOperations["getRuntimeConfig"]>
      >;
    },
    async getUnitsPreference(request) {
      return finalFrame(await invoke("getUnitsPreference", request)) as {
        value: "metric" | "imperial";
        source: "cycling" | "athlete" | "default";
      };
    },
    async setUnitsPreference(request) {
      return finalFrame(await invoke("setUnitsPreference", request)) as {
        value: "metric" | "imperial";
        source: "cycling";
      };
    },
  };
  const spend: SpendOperations = {
    async getSpendSummary(request) {
      return finalFrame(await invoke("getSpendSummary", request)) as Awaited<
        ReturnType<SpendOperations["getSpendSummary"]>
      >;
    },
    async setDailySpendCap(request) {
      return finalFrame(await invoke("setDailySpendCap", request)) as Awaited<
        ReturnType<SpendOperations["setDailySpendCap"]>
      >;
    },
  };
  const rpc = createCoachRpcServer({
    engine,
    operations,
    spend,
    selfTestOperations: {
      selfTest: async () => ({
        schemaVersion: 1,
        type: "self-test-terminal",
        ok: false,
        error: { code: "RUNNER_ERROR", message: "packaged self-test failed" },
      }),
    },
    telegram: disabledTelegram,
    token: input.token,
    athleteHome,
    owner: "unmanaged-foreground",
  });
  const binding = await lock.listener.bind({
    request: createHealthzRequestHandler({ appVersion: "0.0.1" }),
    upgrade: rpc.handleUpgrade,
  });
  const debuggerPort = await reservePort();
  const executable = require("electron") as string;
  const child = spawn(
    executable,
    [desktopRoot, `--remote-debugging-port=${debuggerPort}`, `--user-data-dir=${userData}`],
    {
      env: {
        ...process.env,
        ENDURAGENT_HOME: athleteHome,
        FORCE_COLOR: undefined,
        NO_COLOR: undefined,
        CLICOLOR_FORCE: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let cdp: Awaited<ReturnType<typeof connectCdp>> | undefined;
  const surfaces: Record<"location" | "console" | "stdout" | "stderr" | "dom", string> = {
    location: "",
    console: "",
    stdout: "",
    stderr: "",
    dom: "",
  };
  const consoleMessages: string[] = [];
  const refreshSurfaces = async (): Promise<void> => {
    if (cdp === undefined) return;
    const result = await cdp.call("Runtime.evaluate", {
      expression: "({ location: location.href, dom: document.documentElement.outerHTML })",
      returnByValue: true,
    });
    const value = ((result.result as Record<string, unknown> | undefined)?.value ?? {}) as Record<
      string,
      unknown
    >;
    surfaces.location = typeof value.location === "string" ? value.location : "";
    surfaces.dom = typeof value.dom === "string" ? value.dom : "";
    surfaces.console = consoleMessages.join("\n");
    surfaces.stdout = stdout;
    surfaces.stderr = stderr;
  };
  let closed = false;
  try {
    const debuggerUrl = await waitForPage(debuggerPort);
    cdp = await connectCdp(debuggerUrl, (message) => {
      if (message.method !== "Runtime.consoleAPICalled") return;
      const args =
        (message.params as { readonly args?: readonly { readonly value?: unknown }[] } | undefined)
          ?.args ?? [];
      consoleMessages.push(args.map((arg) => String(arg.value ?? "")).join(" "));
    });
    await Promise.all([
      cdp.call("Runtime.enable"),
      cdp.call("Page.enable"),
      cdp.call("Emulation.setEmulatedMedia", {
        features: [
          { name: "prefers-color-scheme", value: input.colorScheme },
          {
            name: "prefers-reduced-motion",
            value: input.reducedMotion ? "reduce" : "no-preference",
          },
        ],
      }),
      cdp.call("Emulation.setDeviceMetricsOverride", {
        width: input.width,
        height: input.height,
        deviceScaleFactor: 1,
        mobile: false,
      }),
    ]);
    await refreshSurfaces();
  } catch (error) {
    await stopProcess(child).catch(() => {});
    await binding.close().catch(() => {});
    await rpc.close().catch(() => {});
    await lock.release().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }
  return {
    async evaluate<T>(source: string): Promise<T> {
      if (closed || cdp === undefined) throw new Error("desktop fixture is closed");
      const response = await cdp.call("Runtime.evaluate", {
        expression: `(async () => { ${source} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      const remote = response.result as
        | { readonly value?: unknown; readonly description?: unknown }
        | undefined;
      if (remote?.description !== undefined && remote.value === undefined) {
        throw new Error(String(remote.description));
      }
      await refreshSurfaces();
      return remote?.value as T;
    },
    async screenshot(path: string) {
      if (closed || cdp === undefined) throw new Error("desktop fixture is closed");
      const response = await cdp.call("Page.captureScreenshot", { format: "png" });
      const data = response.data;
      if (typeof data !== "string") throw new TypeError("desktop screenshot was not returned");
      await writeFile(path, Buffer.from(data, "base64"));
      await refreshSurfaces();
    },
    async setViewport(width: number, height: number) {
      if (closed || cdp === undefined) throw new Error("desktop fixture is closed");
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await refreshSurfaces();
    },
    readCapturedSurface(name) {
      if (name === "stdout") return stdout;
      if (name === "stderr") return stderr;
      return surfaces[name];
    },
    async close() {
      if (closed) return { livePids: [], listenerCount: 0 };
      closed = true;
      const pid = child.pid;
      if (cdp !== undefined && cdp.socket.readyState === WebSocket.OPEN) {
        await cdp.call("Browser.close").catch(() => {});
        cdp.socket.close();
      }
      await stopProcess(child).catch(() => {});
      await binding.close().catch(() => {});
      await rpc.close().catch(() => {});
      await lock.release().catch(() => {});
      await rm(scratch, { recursive: true, force: true });
      const livePids = pid !== undefined && processAlive(pid) ? [pid] : [];
      return { livePids, listenerCount: 0 };
    },
  };
}
