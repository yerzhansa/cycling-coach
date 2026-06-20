import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { getCoachHome } from "./coach-home.js";
import { createSubsystemLogger, serializeError } from "./logging/index.js";

const BREADCRUMB_FILE = "last-run.json";

interface Breadcrumb {
  startedAt: number;
  status: "running" | "unclean";
  uncleanAt?: number;
}

// Re-entrancy latch: a throw inside a crash handler must not re-enter and loop.
let crashing = false;
let handlersInstalled = false;

function breadcrumbPath(dataDir: string): string {
  return join(dataDir, BREADCRUMB_FILE);
}

function readBreadcrumb(dataDir: string): Breadcrumb | undefined {
  try {
    const raw = readFileSync(breadcrumbPath(dataDir), "utf-8");
    return JSON.parse(raw) as Breadcrumb;
  } catch {
    return undefined;
  }
}

// All breadcrumb writes are synchronous and best-effort swallowed: a crash
// handler is about to exit, and a breadcrumb write that threw would mask the
// original error that triggered the handler.
function writeBreadcrumb(dataDir: string, crumb: Breadcrumb): void {
  try {
    writeFileSync(breadcrumbPath(dataDir), JSON.stringify(crumb), {
      encoding: "utf-8",
      mode: 0o600,
    });
  } catch {
    // Swallow — observability must never break the process.
  }
}

function markUnclean(dataDir: string): void {
  const prior = readBreadcrumb(dataDir);
  writeBreadcrumb(dataDir, {
    startedAt: prior?.startedAt ?? Date.now(),
    status: "unclean",
    uncleanAt: Date.now(),
  });
}

function writeLastGaspLine(dataDir: string, event: string, err: unknown): void {
  try {
    const log = createSubsystemLogger("agent", dataDir);
    // Delegate redaction to the substrate's serializeError (the single
    // redaction surface) rather than naming any payload field here.
    log.error(event, undefined, { err: serializeError(err) });
  } catch {
    // The logger never throws by contract, but the handler stays defensive.
  }
}

export function installCrashHandlers(opts: { dataDir: string }): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  const onDeath = (event: string) => (err: unknown) => {
    if (crashing) return;
    crashing = true;
    writeLastGaspLine(opts.dataDir, event, err);
    markUnclean(opts.dataDir);
    process.exit(1);
  };

  process.on("uncaughtException", onDeath("uncaught_exception"));
  process.on("unhandledRejection", onDeath("unhandled_rejection"));
}

export function logBootLine(opts: { dataDir: string }): void {
  const prior = readBreadcrumb(opts.dataDir);
  const log = createSubsystemLogger("agent", opts.dataDir);
  try {
    log.info("boot", { pid: process.pid });
    if (prior !== undefined) {
      // Any breadcrumb still present at boot means the prior run never reached a
      // clean shutdown (which deletes it): `unclean` = a crash handler fired and
      // recorded the death; `running` = a hard death (SIGKILL / power loss) with
      // no handler. Both must surface, and a handler-recorded `uncleanAt` must
      // carry into this durable line before the file is re-armed below.
      log.warn("previous_run_unclean", undefined, {
        startedAt: prior.startedAt,
        priorStatus: prior.status,
        ...(prior.uncleanAt !== undefined ? { uncleanAt: prior.uncleanAt } : {}),
      });
    }
  } catch {
    // The logger never throws by contract; stay defensive at startup.
  }
  writeBreadcrumb(opts.dataDir, { startedAt: Date.now(), status: "running" });
}

export function markCleanShutdown(opts: { dataDir: string }): void {
  try {
    unlinkSync(breadcrumbPath(opts.dataDir));
  } catch {
    // Already absent or unwritable — nothing to clear.
  }
}

function isTokenError(err: unknown): { code: number } | undefined {
  const code = (err as { error_code?: unknown })?.error_code;
  if (code === 401 || code === 409) return { code };
  return undefined;
}

export function reportFatal(err: unknown, opts: { dataDir?: string } = {}): never {
  const dataDir = opts.dataDir ?? getCoachHome("cycling-coach");
  writeLastGaspLine(dataDir, "fatal", err);
  markUnclean(dataDir);

  const token = isTokenError(err);
  if (token?.code === 401) {
    console.error(
      "Telegram rejected the bot token (401 Unauthorized). The token was revoked or is invalid — generate a new one with @BotFather and update your config, then restart.",
    );
  } else if (token?.code === 409) {
    console.error(
      "Telegram reported a conflict (409) — another instance is already polling this bot token. Stop the other instance, then restart.",
    );
  }

  process.exit(1);
}

export function __resetProcessGuardForTesting(): void {
  crashing = false;
  handlersInstalled = false;
}
