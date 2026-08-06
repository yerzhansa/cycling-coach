import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectCdp, reservePort, waitForPage } from "../tests/helpers/desktop-fixture.js";
import {
  prepareDisposableKeychain,
  type DisposableKeychain,
} from "../tests/fixtures/packaged-telegram/disposable-keychain.js";
import {
  classifyDarwinProcessObservation,
  parseDarwinProcessObservation,
  releaseAcceptanceStorage,
  type DarwinProcessBirthIdentity,
  type DarwinProcessObservation,
} from "../tests/fixtures/packaged-telegram/process-safety.js";
import {
  ACCEPTANCE_OS_LOGIN_MARKER_ENV,
  ACCEPTANCE_OS_LOGIN_MARKER_VALUE,
} from "../tests/fixtures/packaged-telegram/startup-mode.js";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const application = join(
  desktopRoot,
  "dist/telegram-acceptance-package/mac-arm64/Enduragent Telegram Acceptance.app",
);
const executable = join(application, "Contents/MacOS/Enduragent Telegram Acceptance");
const TELEGRAM_VAULT_DIRECTORY = "telegram-channel-v1";
const TELEGRAM_PROFILE_FILE = "profile.bin";
const TELEGRAM_DESIRED_STATE_FILE = "desired-state.json";
const BACKGROUND_PREFERENCE_DIRECTORY = "desktop-preferences-v1";
const BACKGROUND_PREFERENCE_FILE = "background-at-login.json";
const ONBOARDING_STORAGE_KEY = "enduragent.desktop.onboarding";
const ONBOARDING_STORAGE_VALUE = '{"version":1,"completed":true}';
const GENERIC_FAILURE = "Sorry, something went wrong. Please try again.";
const BOT_USERNAME = "EnduragentAcceptanceBot";
const BOT_ID = 71_234_567;
const SENDER_ID = 42_424_242;

interface CommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

interface RunningApplication {
  readonly child: ChildProcess;
  readonly debugPort: number;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly output: () => { readonly stdout: string; readonly stderr: string };
}

interface SentMessage {
  readonly chatId: number;
  readonly text: string;
}

interface GetUpdatesRequestObservation {
  readonly sequence: number;
  readonly offset: number;
  readonly selectedUpdateIds: readonly number[];
  readonly settled: boolean;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message: {
    readonly message_id: number;
    readonly date: number;
    readonly from: {
      readonly id: number;
      readonly is_bot: false;
      readonly first_name: string;
      readonly username: string;
    };
    readonly chat: {
      readonly id: number;
      readonly type: "private";
      readonly first_name: string;
      readonly username: string;
    };
    readonly text: string;
    readonly entities?: readonly {
      readonly offset: 0;
      readonly length: number;
      readonly type: "bot_command";
    }[];
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitUntil(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly input?: Buffer | string;
    readonly allowFailure?: boolean;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      env: options.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (!options.allowFailure && (code !== 0 || signal !== null)) {
        rejectRun(new Error(`${command} failed`));
      } else {
        resolveRun(result);
      }
    });
    child.stdin.end(options.input);
  });
}

async function clipboardBytes(): Promise<Buffer> {
  const result = await runCommand("/usr/bin/pbpaste", [], { allowFailure: true });
  return result.stdout;
}

async function writeClipboard(value: Buffer | string): Promise<void> {
  await runCommand("/usr/bin/pbcopy", [], { input: value });
}

function parseRequestBody(chunks: readonly Buffer[]): Record<string, unknown> {
  const source = Buffer.concat(chunks).toString("utf8");
  if (source.length === 0) return {};
  const value = JSON.parse(source) as unknown;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Bot API payload is invalid");
  }
  return value as Record<string, unknown>;
}

function botApiResponse(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    connection: "close",
  });
  response.end(bytes);
}

function privateUpdate(updateId: number, messageId: number, text: string): TelegramUpdate {
  const command = text.startsWith("/");
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 946_684_800 + messageId,
      from: {
        id: SENDER_ID,
        is_bot: false,
        first_name: "Acceptance",
        username: "acceptance_athlete",
      },
      chat: {
        id: SENDER_ID,
        type: "private",
        first_name: "Acceptance",
        username: "acceptance_athlete",
      },
      text,
      ...(command
        ? { entities: [{ offset: 0 as const, length: text.length, type: "bot_command" as const }] }
        : {}),
    },
  };
}

async function createTelegramBotApi(token: string) {
  let updateSequence = 1_000;
  let messageSequence = 2_000;
  let pollRequests = 0;
  let cancelledPolls = 0;
  let getUpdatesSequence = 0;
  const updates: TelegramUpdate[] = [];
  const sentMessages: SentMessage[] = [];
  const methods: string[] = [];
  const contentTypes = new Set<string>();
  const chatActions: Record<string, unknown>[] = [];
  const getUpdatesRequests: {
    sequence: number;
    offset: number;
    selectedUpdateIds: number[];
    settled: boolean;
  }[] = [];
  const pending = new Set<{
    readonly payload: Record<string, unknown>;
    readonly response: ServerResponse;
    readonly observation: (typeof getUpdatesRequests)[number];
  }>();

  const requestOffset = (payload: Record<string, unknown>): number =>
    typeof payload.offset === "number" && Number.isSafeInteger(payload.offset) ? payload.offset : 0;
  const selectUpdates = (payload: Record<string, unknown>): readonly TelegramUpdate[] => {
    const offset = requestOffset(payload);
    const limit =
      typeof payload.limit === "number" && Number.isSafeInteger(payload.limit)
        ? payload.limit
        : 100;
    return updates.filter((update) => update.update_id >= offset).slice(0, limit);
  };
  const settleGetUpdates = (
    waiter: {
      readonly response: ServerResponse;
      readonly observation: (typeof getUpdatesRequests)[number];
    },
    selected: readonly TelegramUpdate[],
  ): void => {
    waiter.observation.selectedUpdateIds = selected.map((update) => update.update_id);
    waiter.observation.settled = true;
    if (!waiter.response.writableEnded) {
      botApiResponse(waiter.response, 200, { ok: true, result: selected });
    }
  };
  const settlePending = (): void => {
    for (const waiter of pending) {
      const selected = selectUpdates(waiter.payload);
      if (selected.length === 0 && waiter.payload.limit !== 1) continue;
      pending.delete(waiter);
      settleGetUpdates(waiter, selected);
    }
  };

  const http = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > 1_048_576) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        if (request.method !== "POST" || request.url === undefined) {
          botApiResponse(response, 405, { ok: false, error_code: 405 });
          return;
        }
        const match = /^\/bot([^/]+)\/([A-Za-z][A-Za-z0-9]*)$/u.exec(request.url);
        if (match === null || match[1] !== token) {
          botApiResponse(response, 401, { ok: false, error_code: 401 });
          return;
        }
        const method = match[2];
        const contentType = request.headers["content-type"];
        if (contentType !== "application/json") {
          botApiResponse(response, 415, { ok: false, error_code: 415 });
          return;
        }
        methods.push(method);
        contentTypes.add(contentType);
        const payload = parseRequestBody(chunks);
        if (method === "getMe") {
          botApiResponse(response, 200, {
            ok: true,
            result: {
              id: BOT_ID,
              is_bot: true,
              first_name: "Enduragent Acceptance",
              username: BOT_USERNAME,
            },
          });
          return;
        }
        if (method === "getWebhookInfo") {
          botApiResponse(response, 200, {
            ok: true,
            result: { url: "", has_custom_certificate: false, pending_update_count: 0 },
          });
          return;
        }
        if (["deleteWebhook", "setMyCommands"].includes(method)) {
          botApiResponse(response, 200, { ok: true, result: true });
          return;
        }
        if (method === "sendChatAction") {
          chatActions.push(payload);
          botApiResponse(response, 200, { ok: true, result: true });
          return;
        }
        if (method === "getUpdates") {
          pollRequests += 1;
          const observation = {
            sequence: ++getUpdatesSequence,
            offset: requestOffset(payload),
            selectedUpdateIds: [] as number[],
            settled: false,
          };
          getUpdatesRequests.push(observation);
          const selected = selectUpdates(payload);
          if (selected.length > 0 || payload.limit === 1) {
            settleGetUpdates({ response, observation }, selected);
            return;
          }
          const waiter = { payload, response, observation };
          pending.add(waiter);
          response.once("close", () => {
            if (pending.delete(waiter) && !response.writableEnded) cancelledPolls += 1;
          });
          return;
        }
        if (method === "sendMessage") {
          if (typeof payload.text !== "string" || payload.text.length === 0) {
            botApiResponse(response, 400, { ok: false, error_code: 400 });
            return;
          }
          const chatId = Number(payload.chat_id);
          if (!Number.isSafeInteger(chatId)) {
            botApiResponse(response, 400, { ok: false, error_code: 400 });
            return;
          }
          sentMessages.push({ chatId, text: payload.text });
          botApiResponse(response, 200, {
            ok: true,
            result: {
              message_id: ++messageSequence,
              date: 946_684_800 + messageSequence,
              chat: { id: chatId, type: "private", first_name: "Acceptance" },
              text: payload.text,
            },
          });
          return;
        }
        botApiResponse(response, 404, { ok: false, error_code: 404 });
      } catch {
        if (!response.writableEnded) {
          botApiResponse(response, 400, { ok: false, error_code: 400 });
        }
      }
    });
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    http.once("error", rejectListen);
    http.listen({ host: "127.0.0.1", port: 0 }, () => resolveListen());
  });
  const address = http.address();
  assert(address !== null && typeof address !== "string", "Bot API listener has no port");
  const listenerPort = address.port;
  return {
    origin: `http://127.0.0.1:${listenerPort}`,
    listenerPort,
    enqueue(text: string): TelegramUpdate {
      const update = privateUpdate(++updateSequence, ++messageSequence, text);
      updates.push(update);
      settlePending();
      return update;
    },
    sentMessages,
    chatActions,
    pollCount: () => pollRequests,
    cancelledPollCount: () => cancelledPolls,
    activePollCount: () => pending.size,
    getUpdatesRequests: (): readonly GetUpdatesRequestObservation[] =>
      getUpdatesRequests.map((request) => ({
        ...request,
        selectedUpdateIds: [...request.selectedUpdateIds],
      })),
    methods: () => [...methods],
    contentTypes: () => [...contentTypes],
    async close() {
      for (const waiter of pending) {
        pending.delete(waiter);
        settleGetUpdates(waiter, []);
      }
      http.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) => {
        http.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    },
  };
}

function launchApplication(
  environment: NodeJS.ProcessEnv,
  debugPort: number,
  userData: string,
): RunningApplication {
  const args = [`--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`];
  const child = spawn(executable, args, {
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  return { child, debugPort, exited, output: () => ({ stdout, stderr }) };
}

interface MainRendererTarget {
  readonly type?: unknown;
  readonly url?: unknown;
  readonly webSocketDebuggerUrl?: unknown;
}

async function mainRendererTargets(port: number): Promise<readonly MainRendererTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error("Desktop debugging target list was unavailable");
  const targets = (await response.json()) as readonly MainRendererTarget[];
  return targets.filter(
    (target) =>
      target.type === "page" &&
      typeof target.url === "string" &&
      target.url.startsWith("enduragent://app/") &&
      typeof target.webSocketDebuggerUrl === "string",
  );
}

async function seedBackgroundAtLoginPreference(userData: string): Promise<void> {
  const root = join(userData, BACKGROUND_PREFERENCE_DIRECTORY);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, BACKGROUND_PREFERENCE_FILE),
    `${JSON.stringify({
      schemaVersion: 2,
      enabled: true,
      loginLaunchBehavior: "background",
    })}\n`,
    { mode: 0o600 },
  );
}

async function cdpPage(port: number) {
  const connection = await connectCdp(await waitForPage(port), () => undefined);
  const evaluate = async <T>(expression: string): Promise<T> => {
    const response = await connection.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails !== undefined) {
      throw new Error("renderer evaluation failed");
    }
    const remote = response.result as { readonly value?: T } | undefined;
    return remote?.value as T;
  };
  return {
    connection,
    evaluate,
    async bodyText(): Promise<string> {
      return evaluate<string>("document.body?.innerText ?? ''");
    },
    async domHtml(): Promise<string> {
      return evaluate<string>("document.documentElement?.outerHTML ?? ''");
    },
    async telegramText(): Promise<string> {
      return evaluate<string>(
        "document.querySelector('section[aria-label=\"Telegram\"]')?.innerText ?? ''",
      );
    },
    async clickButton(label: string): Promise<void> {
      const clicked = await evaluate<boolean>(`(() => {
        const label = ${JSON.stringify(label)};
        const button = [...document.querySelectorAll("button")].find((candidate) =>
          candidate.textContent?.trim() === label && !candidate.disabled
        );
        if (!(button instanceof HTMLButtonElement)) return false;
        button.click();
        return true;
      })()`);
      assert(clicked, `enabled renderer button was not found: ${label}`);
    },
    async screenshot(path: string): Promise<void> {
      await connection.call("Page.enable");
      const captured = await connection.call("Page.captureScreenshot", { format: "png" });
      assert(typeof captured.data === "string", "renderer screenshot was not captured");
      await writeFile(path, Buffer.from(captured.data, "base64"), { mode: 0o600 });
    },
    closeSocket(): void {
      connection.socket.close();
    },
  };
}

async function waitForButton(
  page: Awaited<ReturnType<typeof cdpPage>>,
  label: string,
): Promise<void> {
  await waitUntil(`renderer button ${label}`, () =>
    page.evaluate<boolean>(`[...document.querySelectorAll("button")].some((candidate) =>
      candidate.textContent?.trim() === ${JSON.stringify(label)} && !candidate.disabled
    )`),
  );
}

async function telegramRendererSnapshot(
  page: Awaited<ReturnType<typeof cdpPage>>,
): Promise<unknown> {
  return page.evaluate(`(async () => {
    const bridgeStatus = await Promise.race([
      window.enduragentAuth.telegramStatus().then(
        (value) => ({ state: "resolved", value }),
        (error) => ({ state: "rejected", error: String(error) }),
      ),
      new Promise((resolve) => setTimeout(() => resolve({ state: "timeout" }), 2_500)),
    ]);
    return {
      rpc: document.documentElement.dataset.rpc ?? null,
      telegram: document.querySelector('section[aria-label="Telegram"]')?.innerText ?? "",
      buttons: [...document.querySelectorAll('section[aria-label="Telegram"] button')].map(
        (button) => ({ label: button.textContent?.trim() ?? "", disabled: button.disabled }),
      ),
      bridgeStatus,
    };
  })()`);
}

async function waitForTelegramText(
  page: Awaited<ReturnType<typeof cdpPage>>,
  expected: string,
): Promise<void> {
  try {
    await waitUntil(`Telegram UI text ${expected}`, async () =>
      (await page.telegramText()).includes(expected),
    );
  } catch {
    const visible = (await page.telegramText()).replace(/\s+/gu, " ").slice(0, 600);
    throw new Error(`Telegram UI did not reach expected state: ${visible}`);
  }
}

async function pairingCode(page: Awaited<ReturnType<typeof cdpPage>>): Promise<string> {
  let code = "";
  await waitUntil("Telegram pairing code", async () => {
    code = await page.evaluate<string>(
      "document.querySelector('[aria-label=\"Telegram pairing code\"]')?.textContent?.trim() ?? ''",
    );
    return /^[A-Z0-9]{6}$/u.test(code);
  });
  return code;
}

async function waitForSentMessage(
  messages: readonly SentMessage[],
  text: string,
  start: number,
): Promise<SentMessage> {
  let found: SentMessage | undefined;
  await waitUntil(
    `Bot API reply ${text}`,
    () => {
      found = messages.slice(start).find((message) => message.text === text);
      return found !== undefined;
    },
    40_000,
  );
  return found as SentMessage;
}

async function processTree(rootPid: number): Promise<readonly number[]> {
  const result = await runCommand("/bin/ps", ["-axo", "pid=,ppid="]);
  const children = new Map<number, number[]>();
  for (const line of result.stdout.toString("utf8").split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match === null) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const values = children.get(parent) ?? [];
    values.push(pid);
    children.set(parent, values);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift() as number;
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

async function observeDarwinProcess(pid: number): Promise<DarwinProcessObservation> {
  const result = await runCommand(
    "/bin/ps",
    ["-ww", "-p", String(pid), "-o", "pid=", "-o", "lstart=", "-o", "command="],
    { allowFailure: true },
  );
  return parseDarwinProcessObservation(result, pid, application);
}

async function captureProcess(
  pid: number,
  trackedProcesses: Map<number, DarwinProcessBirthIdentity>,
): Promise<boolean> {
  const observation = await observeDarwinProcess(pid);
  if (observation.state === "absent") return false;
  const existing = trackedProcesses.get(pid);
  if (
    existing !== undefined &&
    classifyDarwinProcessObservation(existing, observation) !== "same"
  ) {
    throw new TypeError(`packaged Desktop PID ${pid} was reused during capture`);
  }
  trackedProcesses.set(pid, observation.identity);
  return true;
}

async function captureApplicationProcesses(
  running: RunningApplication,
  trackedProcesses: Map<number, DarwinProcessBirthIdentity>,
): Promise<void> {
  const rootPid = running.child.pid;
  if (rootPid === undefined) return;
  if (!(await captureProcess(rootPid, trackedProcesses))) return;
  for (const pid of await processTree(rootPid)) {
    await captureProcess(pid, trackedProcesses);
  }
}

async function sameTrackedProcessRunning(identity: DarwinProcessBirthIdentity): Promise<boolean> {
  const observation = await observeDarwinProcess(identity.pid);
  const state = classifyDarwinProcessObservation(identity, observation);
  if (state === "reused") {
    throw new TypeError(`packaged Desktop PID ${identity.pid} was reused`);
  }
  return state === "same";
}

async function signalTrackedProcesses(
  trackedProcesses: ReadonlyMap<number, DarwinProcessBirthIdentity>,
  signal: NodeJS.Signals,
): Promise<void> {
  const errors: unknown[] = [];
  for (const identity of trackedProcesses.values()) {
    if (identity.pid === process.pid) {
      errors.push(new Error("packaged Desktop process tracking included the acceptance driver"));
      continue;
    }
    try {
      if (!(await sameTrackedProcessRunning(identity))) continue;
      try {
        process.kill(identity.pid, signal);
      } catch (error) {
        if (await sameTrackedProcessRunning(identity)) errors.push(error);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `packaged Desktop ${signal} failed`);
}

async function waitForTrackedProcessExit(
  trackedProcesses: ReadonlyMap<number, DarwinProcessBirthIdentity>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let running = false;
    for (const identity of trackedProcesses.values()) {
      if (await sameTrackedProcessRunning(identity)) running = true;
    }
    if (!running) return true;
    await delay(50);
  }
  for (const identity of trackedProcesses.values()) {
    if (await sameTrackedProcessRunning(identity)) return false;
  }
  return true;
}

async function terminateTrackedProcesses(
  trackedProcesses: ReadonlyMap<number, DarwinProcessBirthIdentity>,
): Promise<void> {
  await signalTrackedProcesses(trackedProcesses, "SIGTERM");
  if (await waitForTrackedProcessExit(trackedProcesses, 5_000)) return;
  await signalTrackedProcesses(trackedProcesses, "SIGKILL");
  if (!(await waitForTrackedProcessExit(trackedProcesses, 5_000))) {
    throw new Error("packaged Desktop processes remained alive");
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveOpen(true);
    });
    socket.once("error", () => resolveOpen(false));
  });
}

async function gracefulQuit(
  running: RunningApplication,
  page: Awaited<ReturnType<typeof cdpPage>>,
  debugPort: number,
  trackedProcesses: Map<number, DarwinProcessBirthIdentity>,
): Promise<void> {
  await captureApplicationProcesses(running, trackedProcesses);
  await page.connection.call("Browser.close").catch(() => undefined);
  const exit = await Promise.race([running.exited, delay(30_000).then(() => undefined)]);
  assert(exit !== undefined, "packaged Desktop did not quit gracefully");
  assert(exit.code === 0 && exit.signal === null, "packaged Desktop quit was not clean");
  assert(
    await waitForTrackedProcessExit(trackedProcesses, 30_000),
    "packaged Desktop process tree remained live after graceful quit",
  );
  await waitUntil("Desktop debugging listener exit", async () => !(await portOpen(debugPort)));
}

async function treeContains(root: string, value: string): Promise<boolean> {
  const marker = Buffer.from(value);
  for (const entry of await readdir(root, { recursive: true })) {
    try {
      if ((await readFile(join(root, entry))).includes(marker)) return true;
    } catch {}
  }
  return false;
}

function modelCredentialFreeEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...base };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENAI_ACCESS_TOKEN",
    "OPENROUTER_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "DEEPSEEK_API_KEY",
    "QWEN_API_KEY",
    "MINIMAX_API_KEY",
    "KIMI_API_KEY",
    "ZAI_API_KEY",
    "ENDURAGENT_LLM_API_KEY",
  ]) {
    delete environment[name];
  }
  return environment;
}

async function assertOutputSecretFree(
  runningApplications: readonly RunningApplication[],
  token: string,
): Promise<void> {
  const output = runningApplications.map((running) => JSON.stringify(running.output())).join("\n");
  assert(!output.includes(token), "Telegram credential reached packaged process output");
}

async function main(): Promise<void> {
  assert(process.platform === "darwin", "packaged Telegram acceptance requires macOS");
  assert(process.arch === "arm64", "packaged Telegram acceptance requires macOS arm64");
  assert(
    process.env.CI === "true" || process.env.ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT === "1",
    "packaged Telegram acceptance requires an explicit disposable safe-storage context",
  );
  assert(existsSync(executable), "packaged Telegram acceptance executable is missing");
  const packageManifest = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  assert(typeof packageManifest.version === "string", "Desktop package version is invalid");

  const base = await realpath(process.platform === "darwin" ? "/tmp" : tmpdir());
  const scratch = await mkdtemp(join(base, "eat-"));
  const athleteHome = join(scratch, "athlete-home");
  const configDirectory = join(athleteHome, "config");
  const operatorHome = join(scratch, "operator-home");
  const operatorPreferences = join(operatorHome, "Library/Preferences");
  const operatorKeychains = join(operatorHome, "Library/Keychains");
  const userData = join(scratch, "user-data");
  const screenshots = join(scratch, "screenshots");
  const results = join(scratch, "results");
  const keychainPath = join(operatorKeychains, "acceptance.keychain-db");
  const token = `123456789:${randomBytes(32).toString("base64url").slice(0, 35)}`;
  const originalClipboard = await clipboardBytes();
  const runningApplications: RunningApplication[] = [];
  const trackedProcesses = new Map<number, DarwinProcessBirthIdentity>();
  let keychain: DisposableKeychain | undefined;
  let telegram: Awaited<ReturnType<typeof createTelegramBotApi>> | undefined;
  let primary: RunningApplication | undefined;
  let page: Awaited<ReturnType<typeof cdpPage>> | undefined;
  let executionError: unknown;
  let cleanupError: AggregateError | undefined;
  let successResult:
    | {
        readonly ok: true;
        readonly packagedVersion: string;
        readonly productionChain: true;
        readonly botApiOnlyFake: true;
        readonly coldStartBackground: true;
        readonly residentLifecycle: true;
        readonly persistedDisable: true;
        readonly removal: true;
      }
    | undefined;
  try {
    await Promise.all([
      mkdir(configDirectory, { recursive: true, mode: 0o700 }),
      mkdir(operatorPreferences, { recursive: true, mode: 0o700 }),
      mkdir(operatorKeychains, { recursive: true, mode: 0o700 }),
      mkdir(userData, { recursive: true, mode: 0o700 }),
      mkdir(screenshots, { recursive: true, mode: 0o700 }),
      mkdir(results, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      join(configDirectory, "config.yaml"),
      [
        "data_source: store",
        `data_dir: ${JSON.stringify(athleteHome)}`,
        "llm:",
        "  provider: openai-codex",
        "  model: gpt-5.6-sol",
        "intervals:",
        "  api_key: ''",
        "  athlete_id: '0'",
        "session:",
        "  timezone: UTC",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const authProfilesPath = join(configDirectory, "auth-profiles.json");
    assert(!existsSync(authProfilesPath), "model auth profile unexpectedly exists");

    telegram = await createTelegramBotApi(token);
    keychain = await prepareDisposableKeychain({
      home: operatorHome,
      path: keychainPath,
      password: randomBytes(32).toString("base64url"),
      environment: process.env,
      run: (args, options) =>
        runCommand("/usr/bin/security", args, {
          allowFailure: true,
          environment: options.environment,
        }),
    });
    await keychain.activate();
    assert(keychain.home === operatorHome, "keychain and application HOME differ");
    let debugPort = await reservePort();
    const environment = modelCredentialFreeEnvironment({
      ...process.env,
      HOME: operatorHome,
      ENDURAGENT_HOME: athleteHome,
      ENDURAGENT_ACCEPTANCE_TELEGRAM_BOT_API_ORIGIN: telegram.origin,
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
    });

    primary = launchApplication(environment, debugPort, userData);
    runningApplications.push(primary);
    page = await cdpPage(debugPort);
    await captureApplicationProcesses(primary, trackedProcesses);
    await page.evaluate(
      `localStorage.setItem(${JSON.stringify(ONBOARDING_STORAGE_KEY)}, ${JSON.stringify(ONBOARDING_STORAGE_VALUE)}); true`,
    );
    await waitForButton(page, "Settings");
    await page.clickButton("Settings");
    try {
      await waitForButton(page, "Paste token from clipboard");
    } catch (error) {
      const renderer = JSON.stringify(await telegramRendererSnapshot(page)).replaceAll(
        token,
        "<redacted>",
      );
      const processOutput = JSON.stringify(primary.output()).replaceAll(token, "<redacted>");
      throw new Error(
        `${error instanceof Error ? error.message : "Telegram settings did not load"}; renderer=${renderer.slice(0, 2_000)}; profile=${existsSync(join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_PROFILE_FILE))}; desired-state=${existsSync(join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_DESIRED_STATE_FILE))}; Bot API methods=${telegram.methods().join(",") || "none"}; process=${processOutput.slice(0, 1_000)}`,
      );
    }

    await writeClipboard(token);
    await page.clickButton("Paste token from clipboard");
    try {
      await waitForTelegramText(page, `@${BOT_USERNAME}`);
    } catch (error) {
      const processOutput = JSON.stringify(primary.output()).replaceAll(token, "<redacted>");
      throw new Error(
        `${error instanceof Error ? error.message : "Telegram setup failed"}; Bot API methods=${telegram.methods().join(",") || "none"}; content-types=${telegram.contentTypes().join(",") || "none"}; process=${processOutput.slice(0, 1_000)}`,
      );
    }
    assert((await clipboardBytes()).length === 0, "Telegram credential remained on the clipboard");
    const profilePath = join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_PROFILE_FILE);
    await waitUntil("encrypted Telegram profile", () => existsSync(profilePath));
    assert(
      !(await readFile(profilePath)).includes(Buffer.from(token)),
      "Telegram profile is plaintext",
    );
    assert(!(await page.bodyText()).includes(token), "Telegram credential reached renderer text");
    await assertOutputSecretFree(runningApplications, token);

    await page.clickButton("Start pairing and turn on");
    const code = await pairingCode(page);
    telegram.enqueue(code);
    await waitForTelegramText(page, "Paired with a primary Telegram user");
    await waitForTelegramText(page, "Online");
    await page.evaluate(`(() => {
      const summary = [...document.querySelectorAll("summary")].find((candidate) =>
        candidate.textContent?.trim() === "Advanced · allowed users"
      );
      if (!(summary instanceof HTMLElement)) return false;
      summary.click();
      return true;
    })()`);
    await waitForTelegramText(page, String(SENDER_ID));
    await page.screenshot(join(screenshots, "paired.png"));

    let messageStart = telegram.sentMessages.length;
    telegram.enqueue("/version");
    await waitForSentMessage(
      telegram.sentMessages,
      `Cycling Coach Desktop v${packageManifest.version}`,
      messageStart,
    );

    messageStart = telegram.sentMessages.length;
    const chatActionStart = telegram.chatActions.length;
    telegram.enqueue("How should I train today?");
    await waitForSentMessage(telegram.sentMessages, GENERIC_FAILURE, messageStart);
    assert(
      telegram.chatActions
        .slice(chatActionStart)
        .some((action) => action.action === "typing" && Number(action.chat_id) === SENDER_ID),
      "free-text Telegram handling did not send a typing action",
    );
    assert(
      !telegram.sentMessages
        .slice(messageStart)
        .some((message) => /(?:tempo|interval|recovery|ride|training plan)/iu.test(message.text)),
      "credential-free acceptance unexpectedly produced substantive coaching",
    );

    const pairedDesired = JSON.parse(
      await readFile(join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_DESIRED_STATE_FILE), "utf8"),
    ) as { readonly enabled?: unknown };
    assert(pairedDesired.enabled === true, "paired Telegram intent was not enabled before restart");
    const pairedAllowed = JSON.parse(
      await readFile(join(athleteHome, "allowed-senders.json"), "utf8"),
    ) as { readonly primaryOperator?: unknown; readonly allowFrom?: unknown };
    assert(
      pairedAllowed.primaryOperator === String(SENDER_ID) &&
        Array.isArray(pairedAllowed.allowFrom) &&
        pairedAllowed.allowFrom.includes(String(SENDER_ID)),
      "paired Telegram access state was not durable before restart",
    );
    await seedBackgroundAtLoginPreference(userData);
    await gracefulQuit(primary, page, debugPort, trackedProcesses);
    primary = undefined;
    page = undefined;

    debugPort = await reservePort();
    const backgroundEnvironment = {
      ...environment,
      [ACCEPTANCE_OS_LOGIN_MARKER_ENV]: ACCEPTANCE_OS_LOGIN_MARKER_VALUE,
    };
    primary = launchApplication(backgroundEnvironment, debugPort, userData);
    runningApplications.push(primary);
    await waitUntil("cold-start Telegram long poll", () => telegram?.activePollCount() === 1);
    await waitUntil("cold-start debugger listener", () => portOpen(debugPort));
    await captureApplicationProcesses(primary, trackedProcesses);
    assert(
      (await mainRendererTargets(debugPort)).length === 0,
      "OS-login cold start created a main renderer",
    );
    messageStart = telegram.sentMessages.length;
    telegram.enqueue("/version");
    await waitForSentMessage(
      telegram.sentMessages,
      `Cycling Coach Desktop v${packageManifest.version}`,
      messageStart,
    );
    assert(
      (await mainRendererTargets(debugPort)).length === 0,
      "background Telegram handling created a main renderer",
    );

    const foregroundRequest = launchApplication(environment, debugPort, userData);
    runningApplications.push(foregroundRequest);
    await captureApplicationProcesses(foregroundRequest, trackedProcesses);
    const foregroundRequestExit = await Promise.race([
      foregroundRequest.exited,
      delay(20_000).then(() => undefined),
    ]);
    assert(foregroundRequestExit !== undefined, "foreground second launch did not exit");
    assert(
      foregroundRequestExit.code === 0 && foregroundRequestExit.signal === null,
      "foreground second launch exit was not clean",
    );
    await waitUntil(
      "one foreground main renderer",
      async () => (await mainRendererTargets(debugPort)).length === 1,
    );
    await delay(250);
    assert(
      (await mainRendererTargets(debugPort)).length === 1,
      "second launch did not open exactly one main renderer",
    );
    page = await cdpPage(debugPort);

    await page.evaluate("window.close(); true").catch(() => undefined);
    page.closeSocket();
    await waitUntil(
      "resident window closure",
      async () => {
        try {
          await waitForPage(debugPort);
          return false;
        } catch {
          const pid = primary?.child.pid;
          const identity = pid === undefined ? undefined : trackedProcesses.get(pid);
          assert(identity !== undefined, "resident Desktop birth identity is missing");
          return sameTrackedProcessRunning(identity);
        }
      },
      25_000,
    );
    messageStart = telegram.sentMessages.length;
    telegram.enqueue("/version");
    await waitForSentMessage(
      telegram.sentMessages,
      `Cycling Coach Desktop v${packageManifest.version}`,
      messageStart,
    );

    const secondary = launchApplication(environment, debugPort, userData);
    runningApplications.push(secondary);
    await delay(250);
    await captureApplicationProcesses(secondary, trackedProcesses);
    const secondaryExit = await Promise.race([
      secondary.exited,
      delay(20_000).then(() => undefined),
    ]);
    assert(secondaryExit !== undefined, "secondary Desktop instance did not exit");
    assert(
      secondaryExit.code === 0 && secondaryExit.signal === null,
      "secondary Desktop instance exit was not clean",
    );
    page = await cdpPage(debugPort);
    await waitForButton(page, "Settings");
    await page.clickButton("Settings");
    await waitForButton(page, "Turn off");
    await waitUntil("active Telegram long poll", () => telegram?.activePollCount() === 1);
    const cancelledPollCount = telegram.cancelledPollCount();
    await page.clickButton("Turn off");
    await waitForButton(page, "Turn on");
    await waitUntil("Telegram polling stop", () => telegram?.activePollCount() === 0);
    assert(
      telegram.cancelledPollCount() > cancelledPollCount,
      "turning Telegram off did not cancel the active long poll",
    );
    const disabledPollCount = telegram.pollCount();
    messageStart = telegram.sentMessages.length;
    const pendingUpdate = telegram.enqueue("/version");
    await delay(1_000);
    assert(telegram.sentMessages.length === messageStart, "disabled Telegram replied to an update");
    assert(telegram.pollCount() === disabledPollCount, "disabled Telegram continued polling");

    await gracefulQuit(primary, page, debugPort, trackedProcesses);
    primary = undefined;
    page = undefined;

    const relaunchPort = await reservePort();
    primary = launchApplication(environment, relaunchPort, userData);
    runningApplications.push(primary);
    page = await cdpPage(relaunchPort);
    await captureApplicationProcesses(primary, trackedProcesses);
    await waitForButton(page, "Settings");
    await page.clickButton("Settings");
    await waitForButton(page, "Turn on");
    const relaunchedDisabledPollCount = telegram.pollCount();
    await delay(1_000);
    assert(
      telegram.pollCount() === relaunchedDisabledPollCount,
      "Telegram did not remain disabled after relaunch",
    );
    await page.clickButton("Turn on");
    await waitForButton(page, "Turn off");
    await waitForSentMessage(
      telegram.sentMessages,
      `Cycling Coach Desktop v${packageManifest.version}`,
      messageStart,
    );
    await waitUntil("pending Telegram update acknowledgement progression", () => {
      const requests = telegram?.getUpdatesRequests() ?? [];
      const selections = requests.filter((request) =>
        request.selectedUpdateIds.includes(pendingUpdate.update_id),
      );
      if (selections.length !== 1) return false;
      return (
        requests.some(
          (request) =>
            request.sequence > (selections[0]?.sequence ?? Number.MAX_SAFE_INTEGER) &&
            request.offset > pendingUpdate.update_id &&
            !request.settled,
        ) && telegram?.activePollCount() === 1
      );
    });
    assert(
      telegram.sentMessages
        .slice(messageStart)
        .filter((message) => message.text === `Cycling Coach Desktop v${packageManifest.version}`)
        .length === 1,
      "pending Telegram update was not delivered exactly once",
    );
    const resumedRequests = telegram.getUpdatesRequests();
    assert(
      resumedRequests.filter((request) =>
        request.selectedUpdateIds.includes(pendingUpdate.update_id),
      ).length === 1 &&
        resumedRequests.some(
          (request) => request.offset > pendingUpdate.update_id && !request.settled,
        ),
      "pending Telegram update offset did not advance exactly once",
    );

    await page.clickButton("Remove bot from this Mac");
    await waitForButton(page, "Remove Telegram bot");
    await page.clickButton("Remove Telegram bot");
    await waitForButton(page, "Paste token from clipboard");
    await waitUntil("Telegram polling stop after removal", () => telegram?.activePollCount() === 0);
    assert(!existsSync(profilePath), "Telegram profile remained after removal");
    const desired = JSON.parse(
      await readFile(join(userData, TELEGRAM_VAULT_DIRECTORY, TELEGRAM_DESIRED_STATE_FILE), "utf8"),
    ) as { readonly enabled?: unknown };
    assert(desired.enabled === false, "Telegram desired state remained enabled after removal");
    const allowedPath = join(athleteHome, "allowed-senders.json");
    assert(existsSync(allowedPath), "allowed-senders.json is missing after removal");
    const allowedSource = await readFile(allowedPath, "utf8");
    const allowed = JSON.parse(allowedSource) as {
      readonly dmPolicy?: unknown;
      readonly allowFrom?: unknown;
      readonly primaryOperator?: unknown;
    };
    assert(allowed.dmPolicy === "pairing", "Telegram DM policy did not reset to pairing");
    assert(
      Array.isArray(allowed.allowFrom) && allowed.allowFrom.length === 0,
      "allowed users remained after removal",
    );
    assert(allowed.primaryOperator === null, "primary Telegram user remained after removal");
    assert(
      !allowedSource.includes(String(SENDER_ID)),
      "primary Telegram sender ID remained on disk",
    );
    assert(!existsSync(authProfilesPath), "model auth profile unexpectedly appeared");
    assert(
      !(await treeContains(userData, token)),
      "Telegram credential remained in Desktop user data",
    );
    assert(
      !(await treeContains(athleteHome, token)),
      "Telegram credential remained in the athlete home",
    );
    assert(!(await page.domHtml()).includes(token), "Telegram credential reached renderer DOM");
    await page.screenshot(join(screenshots, "removed.png"));
    await assertOutputSecretFree(runningApplications, token);
    await writeFile(
      join(results, "summary.json"),
      `${JSON.stringify({
        ok: true,
        packagedVersion: packageManifest.version,
        paired: true,
        residentReply: true,
        coldStartBackground: true,
        remainedDisabled: true,
        pendingDeliveredOnce: true,
        removed: true,
      })}\n`,
      { mode: 0o600 },
    );
    await gracefulQuit(primary, page, relaunchPort, trackedProcesses);
    primary = undefined;
    page = undefined;
    successResult = {
      ok: true,
      packagedVersion: packageManifest.version,
      productionChain: true,
      botApiOnlyFake: true,
      coldStartBackground: true,
      residentLifecycle: true,
      persistedDisable: true,
      removal: true,
    };
  } catch (error) {
    executionError = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    const attempt = async (cleanup: () => void | Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };

    await attempt(() => page?.closeSocket());
    let processTeardownSafe = true;
    for (const running of runningApplications) {
      try {
        await captureApplicationProcesses(running, trackedProcesses);
      } catch (error) {
        processTeardownSafe = false;
        cleanupErrors.push(error);
      }
    }
    try {
      await terminateTrackedProcesses(trackedProcesses);
    } catch (error) {
      processTeardownSafe = false;
      cleanupErrors.push(error);
    }
    try {
      if (!(await waitForTrackedProcessExit(trackedProcesses, 0))) {
        processTeardownSafe = false;
        cleanupErrors.push(new Error("tracked packaged Desktop process remained live"));
      }
    } catch (error) {
      processTeardownSafe = false;
      cleanupErrors.push(error);
    }
    let debuggerListenersClosed = true;
    for (const debugPort of new Set(runningApplications.map((running) => running.debugPort))) {
      try {
        await waitUntil(
          `Desktop debugging listener ${debugPort} to close`,
          async () => !(await portOpen(debugPort)),
          5_000,
        );
      } catch (error) {
        debuggerListenersClosed = false;
        cleanupErrors.push(error);
      }
    }
    await attempt(async () => {
      const botApi = telegram;
      if (botApi === undefined) return;
      await botApi.close();
      await waitUntil(
        "Bot API listener to close",
        async () => !(await portOpen(botApi.listenerPort)),
        5_000,
      );
    });
    await attempt(() => writeClipboard(originalClipboard));

    try {
      await releaseAcceptanceStorage({
        processesStopped: processTeardownSafe,
        debuggerListenersClosed,
        recoveryPath: keychain?.recoveryPath ?? keychainPath,
        restoreKeychain: async () => {
          if (keychain === undefined) return true;
          await keychain.restore();
          return keychain.restored();
        },
        removeScratch: () => rm(scratch, { recursive: true, force: true }),
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      cleanupError = new AggregateError(
        executionError === undefined ? cleanupErrors : [executionError, ...cleanupErrors],
        "packaged Telegram acceptance cleanup failed",
      );
    }
  }
  if (cleanupError !== undefined) throw cleanupError;
  if (executionError !== undefined) throw executionError;
  assert(successResult !== undefined, "packaged Telegram acceptance produced no result");
  process.stdout.write(`${JSON.stringify(successResult)}\n`);
}

await main();
