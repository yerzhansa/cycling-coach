export interface DarwinProcessCommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface DarwinProcessBirthIdentity {
  readonly pid: number;
  readonly startToken: string;
  readonly command: string;
  readonly bundleRoot: string;
}

export type DarwinProcessObservation =
  | { readonly state: "absent" }
  | { readonly state: "running"; readonly identity: DarwinProcessBirthIdentity };

const DARWIN_START_TOKEN = /^[A-Z][a-z]{2} [A-Z][a-z]{2} [ 0-9][0-9] \d{2}:\d{2}:\d{2} \d{4}$/u;

export function parseDarwinProcessObservation(
  result: DarwinProcessCommandResult,
  expectedPid: number,
  bundleRoot: string,
): DarwinProcessObservation {
  if (!Number.isSafeInteger(expectedPid) || expectedPid < 1 || !bundleRoot.endsWith(".app")) {
    throw new TypeError("tracked process authority is invalid");
  }
  if (
    result.code === 1 &&
    result.signal === null &&
    result.stdout.length === 0 &&
    result.stderr.length === 0
  ) {
    return { state: "absent" };
  }
  if (result.code !== 0 || result.signal !== null) {
    throw new TypeError("tracked process observation failed");
  }
  const lines = result.stdout
    .toString("utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "");
  if (lines.length !== 1) throw new TypeError("tracked process observation is ambiguous");
  const match = /^\s*(\d+)\s+(.{24})\s+(.+)$/u.exec(lines[0] as string);
  if (match === null) throw new TypeError("tracked process observation is malformed");
  const pid = Number(match[1]);
  const startToken = match[2] as string;
  const command = (match[3] as string).trim();
  if (
    pid !== expectedPid ||
    !DARWIN_START_TOKEN.test(startToken) ||
    !command.startsWith(`${bundleRoot}/Contents/`)
  ) {
    throw new TypeError("tracked process identity is outside the acceptance bundle");
  }
  return {
    state: "running",
    identity: { pid, startToken, command, bundleRoot },
  };
}

export function classifyDarwinProcessObservation(
  tracked: DarwinProcessBirthIdentity,
  observation: DarwinProcessObservation,
): "same" | "exited" | "reused" {
  if (observation.state === "absent") return "exited";
  return observation.identity.pid === tracked.pid &&
    observation.identity.startToken === tracked.startToken &&
    observation.identity.command === tracked.command &&
    observation.identity.bundleRoot === tracked.bundleRoot
    ? "same"
    : "reused";
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
