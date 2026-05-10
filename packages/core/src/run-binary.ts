import { parseArgs } from "node:util";
import { createInterface as createReadlineInterface } from "node:readline";
import type { Sport } from "./sport.js";
import type { BinaryConfig } from "./binary.js";
import type { Memory } from "./memory/store.js";
import type { LatestJson } from "./reference/schemas/latest.js";
import { CONFIG_DIR, envInt } from "./config.js";
import {
  addSender,
  removeSender,
  listSenders,
  loadAllowedSenders,
} from "./channels/allowed-senders.js";

export interface RunBinaryHooks {
  /** Called once per process at startup, after Memory exists, before any chat handler is reachable. */
  onStartup?: (memory: Memory) => void | Promise<void>;
}

function usage(binary: BinaryConfig): string {
  return `Usage: ${binary.binaryName} [command]

Commands:
  setup                     Interactive wizard to create the config file
  version                   Show current version
  add-sender <userId>       Authorize a Telegram user-id to interact with the bot
  remove-sender <userId>    Revoke a previously-authorized Telegram user-id
  list-senders              Show current allowlist + known session candidates
  (none)                    Start the coaching agent (Telegram or CLI mode)

Options:
  --help                    Show this help message`;
}

function parseCommand(binary: BinaryConfig): { command: string | null; positionals: string[] } {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: "boolean" } },
    strict: false,
  });
  if (values.help) {
    console.log(usage(binary));
    process.exit(0);
  }
  return { command: positionals[0] ?? null, positionals };
}

// Readline-based confirmation for startup capture: renders a multi-line prompt
// to make the bot username visually prominent, parses with decline-on-ambiguous
// semantics, declines cleanly on SIGINT, and times out after
// CYCLING_COACH_CAPTURE_CONFIRM_TIMEOUT_MS (default 5 min).

interface MakeReadlineConfirmOpts {
  timeoutMs: number;
  /** Inject for tests. Defaults to node:readline createInterface. */
  createInterface?: (opts: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
  }) => {
    question(prompt: string, cb: (answer: string) => void): void;
    on(event: "SIGINT", cb: () => void): unknown;
    close(): void;
  };
  /** Inject for tests. */
  log?: (line: string) => void;
}

export function _parseConfirmAnswer(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "" || trimmed === "y" || trimmed === "yes") return true;
  // Anything outside {y, yes, Enter, n, no} → decline-on-ambiguous (no re-prompt).
  return false;
}

export function makeReadlineConfirm(
  opts: MakeReadlineConfirmOpts,
): (info: {
  capturedId: string;
  senderUsername: string | undefined;
  senderFirstName: string | undefined;
  botUsername: string;
  binaryName: string;
}) => Promise<boolean> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const create = opts.createInterface ?? createReadlineInterface;

  return async (info) => {
    log("");
    log("==========================================================");
    log(`  Captured operator ID for @${info.botUsername}`);
    log("==========================================================");
    log(`  User ID:      ${info.capturedId}`);
    log(`  Telegram:     @${info.senderUsername ?? "—"}`);
    log(`  Display name: ${info.senderFirstName ?? "—"}`);
    log("==========================================================");
    log("");

    const rl = create({ input: process.stdin, output: process.stdout });

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        try {
          rl.close();
        } catch {
          /* ignore */
        }
        resolve(value);
      };

      const timer = setTimeout(() => finish(false), opts.timeoutMs);

      rl.on("SIGINT", () => {
        clearTimeout(timer);
        finish(false);
      });

      rl.question("Save this as the primary operator? [Y/n]: ", (answer: string) => {
        clearTimeout(timer);
        finish(_parseConfirmAnswer(answer));
      });
    });
  };
}

async function runStartupCapture(
  botToken: string,
  binary: BinaryConfig,
  dataDir: string,
): Promise<void> {
  console.log(
    `\n${binary.displayName} has no allowed senders configured.\n` +
      `Send /start to your bot from Telegram within 60 seconds to claim ownership.\n` +
      `(Press Ctrl+C to skip — you can run \`${binary.binaryName} add-sender <id>\` later.)\n`,
  );
  const { captureAndPersistOperator } = await import("./channels/operator-capture.js");
  const captureTimeoutMs = envInt("CYCLING_COACH_SETUP_CAPTURE_TIMEOUT_MS") ?? 60_000;
  const confirmTimeoutMs = envInt("CYCLING_COACH_CAPTURE_CONFIRM_TIMEOUT_MS") ?? 300_000;
  const result = await captureAndPersistOperator({
    botToken,
    binary,
    dataDir,
    timeoutMs: captureTimeoutMs,
    confirm: makeReadlineConfirm({ timeoutMs: confirmTimeoutMs }),
  });
  if (result.status === "captured") {
    console.log(`Operator registered (id: ${result.capturedId}). Starting bot...`);
  } else {
    console.log(
      `Operator not captured (${result.status}). Bot will start in pairing mode — DM it to receive your user-ID, then run \`${binary.binaryName} add-sender <id>\`.`,
    );
  }
}

const MUTATORS: Record<
  "add-sender" | "remove-sender",
  { fn: (dir: string, id: string) => void; verb: string }
> = {
  "add-sender": { fn: addSender, verb: "Added" },
  "remove-sender": { fn: removeSender, verb: "Removed" },
};

async function runAllowlistCommand(
  command: "add-sender" | "remove-sender" | "list-senders",
  positionals: string[],
  binary: BinaryConfig,
): Promise<void> {
  const reportError = (err: unknown): never => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    return process.exit(1);
  };

  if (command === "add-sender" || command === "remove-sender") {
    const { fn, verb } = MUTATORS[command];
    const id = positionals[1];
    if (!id) {
      console.error(`Usage: ${binary.binaryName} ${command} <userId>`);
      process.exit(1);
    }
    try {
      fn(CONFIG_DIR, id);
    } catch (err) {
      reportError(err);
    }
    console.log(`${verb} sender ${id}.`);
    process.exit(0);
  }

  let result: Awaited<ReturnType<typeof listSenders>>;
  try {
    result = await listSenders(CONFIG_DIR);
  } catch (err) {
    return reportError(err);
  }
  console.log(`Policy: ${result.senders.dmPolicy}`);
  console.log(`Primary operator: ${result.senders.primaryOperator ?? "—"}`);
  console.log(`Allowed senders (${result.senders.allowFrom.length}):`);
  for (const id of result.senders.allowFrom) {
    const added = result.senders.addedAt[id];
    console.log(`  ${id}${added ? `  added ${added}` : ""}`);
  }
  console.log(`Session candidates (${result.sessionCandidates.length}):`);
  for (const c of result.sessionCandidates) {
    console.log(`  ${c.chatId}  ${c.lineCount} lines  last modified ${c.lastModified}`);
  }
  process.exit(0);
}

export async function runStartupHook(
  memory: Memory,
  hook?: RunBinaryHooks["onStartup"],
): Promise<void> {
  if (!hook) return;
  try {
    await hook(memory);
  } catch (err) {
    console.warn(
      `Startup hook failed: ${err instanceof Error ? err.message : String(err)}. Continuing with binary startup.`,
    );
  }
}

export async function runBinary(
  sport: Sport,
  binary: BinaryConfig,
  hooks: RunBinaryHooks = {},
): Promise<void> {
  const { command, positionals } = parseCommand(binary);

  if (command === "setup") {
    const { runSetup } = await import("./setup.js");
    await runSetup(binary);
    // pi-ai's OAuth callback server may leave socket/timer handles alive;
    // exit explicitly so the wizard returns the shell.
    process.exit(0);
  }

  if (command === "version") {
    const { getCurrentVersion } = await import("./updater.js");
    console.log(`${binary.binaryName} v${getCurrentVersion(binary.binaryName)}`);
    return;
  }

  if (command === "add-sender" || command === "remove-sender" || command === "list-senders") {
    await runAllowlistCommand(command, positionals, binary);
    return;
  }

  if (command) {
    console.error(`Unknown command: ${command}\n`);
    console.log(usage(binary));
    process.exit(1);
  }

  const { loadConfig, resolveConfigSecrets } = await import("./config.js");
  const { SecretResolutionError } = await import("./secrets/types.js");

  let config;
  try {
    config = await resolveConfigSecrets(loadConfig());
  } catch (err) {
    if (err instanceof SecretResolutionError) {
      console.error(`Config error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  if (config.llm.provider !== "openai-codex" && !config.llm.apiKey) {
    console.error(
      `No LLM API key found. Run \`${binary.binaryName} setup\` to configure, or set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY.`,
    );
    process.exit(1);
  }

  const { CoachAgent } = await import("./agent/coach-agent.js");
  const agent = new CoachAgent(sport, config);

  // ─── Init order pinned by PRD Decision 13 + ADR-0011 ──────────────────
  // Step 1: Memory (constructed inside `new CoachAgent` above).
  // Step 2: Startup hook (binary-specific; cycling-coach runs migrate).
  await runStartupHook(agent.getMemory(), hooks.onStartup);

  // Step 3: Construct Reference services. Two-phase scheduler — NO timer
  // registered yet (architect-final ADR-0011). The first runSync (step 4)
  // writes `.scheduler.json`; only then does step 5b call `start()`.
  const { mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const referenceData = join(config.dataDir, "data");
  mkdirSync(referenceData, { recursive: true });

  const { AsyncMutex } = await import("./reference/sync/mutex.js");
  const { Cooldown } = await import("./reference/sync/cooldown.js");
  const { createRunSync } = await import("./reference/sync/run-sync.js");
  const { Scheduler } = await import("./reference/sync/scheduler.js");
  const { makeProductionFetcher } = await import(
    "./reference/sync/fetch-reference-data.js"
  );
  const { safeReadJson: refSafeRead } = await import("./reference/io/safe-read.js");
  const { LatestJsonSchema } = await import("./reference/schemas/latest.js");
  const { SYNC_COOLDOWN_MS, SCHEDULED_SYNC_INTERVAL_MS } = await import(
    "./reference/freshness.js"
  );

  const refMutex = new AsyncMutex();
  const refCooldown = new Cooldown();
  const runSync = createRunSync({
    dataDir: referenceData,
    mutex: refMutex,
    cooldown: refCooldown,
    cooldownWindowMs: SYNC_COOLDOWN_MS,
    fetchReferenceData: makeProductionFetcher({
      apiKey: config.intervals.apiKey,
      athleteId: config.intervals.athleteId,
    }),
  });
  const scheduler = new Scheduler({
    dataDir: referenceData,
    runSync,
    intervalMs: SCHEDULED_SYNC_INTERVAL_MS,
  });

  // Step 4: First runSync (best-effort — failure logs but never crashes).
  try {
    await runSync({ caller: "scheduled" });
  } catch (err) {
    console.warn(
      `Reference: initial sync failed (${err instanceof Error ? err.message : String(err)}). Continuing with empty cache; lazy fallback will retry.`,
    );
  }

  // Step 5: Lazy `Person.units` bootstrap — Wave 6 fills (no-op slot).

  // Step 5b: Start the periodic scheduler. Reads now-current `.scheduler.json`.
  scheduler.start();

  const referenceServices = {
    runSync,
    loadLatest: (): LatestJson | null =>
      refSafeRead<LatestJson>(join(referenceData, "latest.json"), LatestJsonSchema),
  };

  if (config.telegram.botToken) {
    // Interactive startup capture: when no allowlist is set up yet AND we have
    // a TTY AND a token, run the same one-message claim flow the setup wizard
    // uses. Non-TTY paths (Docker, systemd, fly.io) skip the prompt and fall
    // back to pairing-mode + pairing-challenge CLI.
    const allowed = loadAllowedSenders(config.dataDir);
    const needsCapture =
      allowed.dmPolicy === "pairing" &&
      allowed.allowFrom.length === 0 &&
      Boolean(config.telegram.botToken) &&
      process.stdin.isTTY === true;
    if (needsCapture) {
      await runStartupCapture(config.telegram.botToken, binary, config.dataDir);
    }

    const { createTelegramBot, notifyUpdate } = await import("./channels/telegram.js");
    // Step 6: Open Telegram with Reference services wired in.
    const bot = createTelegramBot(
      config.telegram.botToken,
      agent,
      binary,
      config.dataDir,
      referenceServices,
    );
    console.log(
      `${binary.displayName} (Telegram mode) is running. Open Telegram and message your bot — Ctrl+C to stop.`,
    );
    bot.start();
    notifyUpdate(bot, config.dataDir, binary).catch(() => {});
  } else {
    console.log(`${binary.displayName} (CLI mode). Type your message:`);
    const { createInterface } = await import("node:readline");
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
    });

    rl.prompt();
    rl.on("line", async (line) => {
      const input = line.trim();
      if (!input) {
        rl.prompt();
        return;
      }
      if (input === "/quit" || input === "/exit") {
        rl.close();
        return;
      }

      try {
        const response = await agent.chat("cli", input);
        console.log("\n" + response + "\n");
      } catch (err) {
        console.error("Error:", err);
      }
      rl.prompt();
    });
  }
}
