import type { ChildProcess } from "node:child_process";

export interface DarwinProcessCommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export const TELEGRAM_ACCEPTANCE_ACCOUNTING_NAME = "Enduragent Teleg";

export type TelegramAcceptanceApplicationLaunch =
  | { readonly state: "spawned"; readonly pid: number }
  | { readonly state: "spawn-error"; readonly error: Error };

export type TelegramAcceptanceApplicationTerminal =
  | {
      readonly state: "closed";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly state: "spawn-error" | "child-error"; readonly error: Error };

export function observeTelegramAcceptanceChild(child: ChildProcess): {
  readonly launch: Promise<TelegramAcceptanceApplicationLaunch>;
  readonly terminal: Promise<TelegramAcceptanceApplicationTerminal>;
} {
  let didSpawn = false;
  let resolveLaunch!: (result: TelegramAcceptanceApplicationLaunch) => void;
  let resolveTerminal!: (result: TelegramAcceptanceApplicationTerminal) => void;
  const launch = new Promise<TelegramAcceptanceApplicationLaunch>((resolve) => {
    resolveLaunch = resolve;
  });
  const terminal = new Promise<TelegramAcceptanceApplicationTerminal>((resolve) => {
    resolveTerminal = resolve;
  });
  child.once("spawn", () => {
    const pid = child.pid;
    if (pid === undefined) {
      const error = new Error("packaged Desktop spawn produced no process ID");
      resolveLaunch({ state: "spawn-error", error });
      resolveTerminal({ state: "spawn-error", error });
      return;
    }
    didSpawn = true;
    resolveLaunch({ state: "spawned", pid });
  });
  child.once("error", (error) => {
    if (didSpawn) {
      resolveTerminal({ state: "child-error", error });
    } else {
      resolveLaunch({ state: "spawn-error", error });
      resolveTerminal({ state: "spawn-error", error });
    }
  });
  child.once("close", (code, signal) => {
    resolveTerminal({ state: "closed", code, signal });
  });
  return { launch, terminal };
}

export function telegramAcceptanceDirectExitIsClean(
  launch: TelegramAcceptanceApplicationLaunch,
  terminal: TelegramAcceptanceApplicationTerminal,
): boolean {
  return (
    launch.state === "spawned" &&
    terminal.state === "closed" &&
    terminal.code === 0 &&
    terminal.signal === null
  );
}

export function telegramAcceptanceBundleTextIsClear(
  result: DarwinProcessCommandResult,
  bundleRoot: string,
): boolean {
  if (typeof bundleRoot !== "string" || !bundleRoot.endsWith(".app")) {
    throw new TypeError("packaged bundle-text authority is invalid");
  }
  if (
    result.code === 1 &&
    result.signal === null &&
    result.stdout.length === 0 &&
    result.stderr.length === 0
  ) {
    return true;
  }
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0 ||
    result.stdout.length === 0
  ) {
    throw new TypeError("packaged bundle-text observation failed");
  }

  const seen = new Set<number>();
  let currentPid: number | undefined;
  let currentDescriptorIsText = false;
  let paths = 0;
  for (const rawField of result.stdout.toString("utf8").split("\0")) {
    const field = rawField.replace(/^[\r\n]+|[\r\n]+$/gu, "");
    if (field === "") continue;
    if (field.includes("\n") || field.includes("\r")) {
      throw new TypeError("packaged bundle-text observation is malformed");
    }
    if (field.startsWith("p")) {
      const pid = Number(field.slice(1));
      if (!Number.isSafeInteger(pid) || pid < 1 || seen.has(pid)) {
        throw new TypeError("packaged bundle-text observation is ambiguous");
      }
      seen.add(pid);
      currentPid = pid;
      currentDescriptorIsText = false;
      continue;
    }
    if (field === "ftxt") {
      if (currentPid === undefined) {
        throw new TypeError("packaged bundle-text observation is malformed");
      }
      currentDescriptorIsText = true;
      continue;
    }
    if (field.startsWith("n")) {
      const path = field.slice(1);
      if (
        currentPid === undefined ||
        !currentDescriptorIsText ||
        (path !== bundleRoot && !path.startsWith(`${bundleRoot}/`))
      ) {
        throw new TypeError("packaged bundle-text observation is outside authority");
      }
      paths += 1;
      currentDescriptorIsText = false;
      continue;
    }
    throw new TypeError("packaged bundle-text observation is malformed");
  }
  if (seen.size === 0 || paths === 0) {
    throw new TypeError("packaged bundle-text observation is empty");
  }
  return false;
}

export function telegramAcceptanceProcessTableIsClear(result: DarwinProcessCommandResult): boolean {
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0 ||
    result.stdout.length === 0
  ) {
    throw new TypeError("packaged process-table observation failed");
  }

  const seen = new Set<number>();
  const lines = result.stdout.toString("utf8").split(/\r?\n/u);
  let observations = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(line);
    if (match === null) throw new TypeError("packaged process-table observation is malformed");
    const pid = Number(match[1]);
    const accountingName = match[2];
    if (!Number.isSafeInteger(pid) || pid < 1 || seen.has(pid) || accountingName === undefined) {
      throw new TypeError("packaged process-table observation is ambiguous");
    }
    seen.add(pid);
    observations += 1;
    if (accountingName === TELEGRAM_ACCEPTANCE_ACCOUNTING_NAME) return false;
  }
  if (observations === 0) {
    throw new TypeError("packaged process-table observation is empty");
  }
  return true;
}

export function telegramAcceptanceDebuggerListenerOwner(
  result: DarwinProcessCommandResult,
): number | undefined {
  if (
    result.code === 1 &&
    result.signal === null &&
    result.stdout.length === 0 &&
    result.stderr.length === 0
  ) {
    return undefined;
  }
  if (
    result.code !== 0 ||
    result.signal !== null ||
    result.stderr.length !== 0 ||
    result.stdout.length === 0
  ) {
    throw new TypeError("Desktop debugger-listener observation failed");
  }
  const pids = new Set<number>();
  const descriptors = new Set<string>();
  for (const rawField of result.stdout.toString("utf8").split("\0")) {
    const field = rawField.replace(/^[\r\n]+|[\r\n]+$/gu, "");
    if (field === "") continue;
    const processMatch = /^p(\d+)$/u.exec(field);
    if (processMatch !== null) {
      const pid = Number(processMatch[1]);
      if (!Number.isSafeInteger(pid) || pid < 1 || pids.has(pid)) {
        throw new TypeError("Desktop debugger-listener observation is ambiguous");
      }
      pids.add(pid);
      continue;
    }
    if (/^f\d+[A-Za-z]?$/u.test(field) && pids.size === 1 && !descriptors.has(field)) {
      descriptors.add(field);
      continue;
    }
    throw new TypeError("Desktop debugger-listener observation is malformed");
  }
  if (pids.size !== 1 || descriptors.size === 0) {
    throw new TypeError("Desktop debugger-listener observation is ambiguous");
  }
  return pids.values().next().value;
}

export function telegramAcceptanceShutdownIsProven(input: {
  readonly executionSucceeded: boolean;
  readonly directApplicationsExitedCleanly: boolean;
  readonly processTableClear: boolean;
}): boolean {
  return (
    input.executionSucceeded && input.directApplicationsExitedCleanly && input.processTableClear
  );
}

export async function releaseAcceptanceStorage(input: {
  readonly processesStopped: boolean;
  readonly debuggerListenersClosed: boolean;
  readonly recoveryPath: string;
  readonly restoreKeychain: () => Promise<boolean>;
  readonly removeScratch: () => Promise<void>;
}): Promise<void> {
  if (!input.processesStopped || !input.debuggerListenersClosed) {
    throw new Error(`acceptance storage retained for recovery at ${input.recoveryPath}`);
  }
  if (!(await input.restoreKeychain())) {
    throw new Error(`acceptance keychain retained for recovery at ${input.recoveryPath}`);
  }
  await input.removeScratch();
}
