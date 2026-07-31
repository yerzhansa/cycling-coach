import {
  EXIT_AGENT_ERROR,
  EXIT_DAEMON_UNAVAILABLE,
  EXIT_SUCCESS,
  EXIT_USAGE,
  type ExitCode,
} from "@enduragent/coach-contract";
import type { CoachCliTerminal } from "../repl.js";

export type DaemonServiceSnapshot =
  | {
      readonly kind: "absent";
      readonly label: string;
      readonly installed: false;
      readonly loaded: false;
      readonly running: false;
      readonly pid: null;
    }
  | {
      readonly kind: "registered";
      readonly label: string;
      readonly installed: boolean;
      readonly loaded: boolean;
      readonly running: boolean;
      readonly pid: number | null;
    }
  | {
      readonly kind: "unknown";
      readonly label: string;
      readonly installed: boolean | null;
      readonly loaded: null;
      readonly running: null;
      readonly pid: null;
    };

export interface CoachDaemonController {
  readonly supported: boolean;
  install(): Promise<DaemonServiceSnapshot>;
  status(): Promise<DaemonServiceSnapshot>;
  restart(): Promise<DaemonServiceSnapshot>;
}

export interface RunCoachDaemonCommandOptions {
  readonly action: "install" | "status" | "restart";
  readonly controller: CoachDaemonController;
  readonly terminal: CoachCliTerminal;
}

export async function runCoachDaemonCommand(
  options: RunCoachDaemonCommandOptions,
): Promise<ExitCode> {
  if (!options.controller.supported) {
    options.terminal.stderr.write("Enduragent service management is available only on macOS.\n");
    return EXIT_USAGE;
  }

  try {
    const snapshot = await options.controller[options.action]();
    if (snapshot.kind === "unknown") {
      options.terminal.stderr.write("Enduragent service status is unavailable.\n");
      return EXIT_DAEMON_UNAVAILABLE;
    }
    if (options.action === "install") {
      if (snapshot.kind !== "registered") throw new Error("service installation failed");
      options.terminal.stdout.write(`Enduragent service installed (${snapshot.label}).\n`);
      return EXIT_SUCCESS;
    }
    if (options.action === "restart") {
      if (snapshot.kind !== "registered") throw new Error("service restart failed");
      options.terminal.stdout.write(`Enduragent service restarted (${snapshot.label}).\n`);
      return EXIT_SUCCESS;
    }
    if (snapshot.kind === "absent") {
      options.terminal.stdout.write(`Enduragent service is not installed (${snapshot.label}).\n`);
      return EXIT_DAEMON_UNAVAILABLE;
    }
    if (!snapshot.running) {
      options.terminal.stdout.write(
        `Enduragent service is registered but stopped (${snapshot.label}).\n`,
      );
      return EXIT_DAEMON_UNAVAILABLE;
    }
    options.terminal.stdout.write(
      `Enduragent service is running (${snapshot.label}, pid ${snapshot.pid ?? "unknown"}).\n`,
    );
    return EXIT_SUCCESS;
  } catch {
    options.terminal.stderr.write("Enduragent service command failed.\n");
    return EXIT_AGENT_ERROR;
  }
}
