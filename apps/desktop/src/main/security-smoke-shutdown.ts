import { connect, type Socket } from "node:net";

export const SECURITY_SMOKE_SHUTDOWN_FRAME = "shutdown\n";
export const SECURITY_SMOKE_SECOND_INSTANCE_FRAME = "DESKTOP_SECURITY_SECOND_INSTANCE\n";
export const SECURITY_SMOKE_PRIMARY_SECOND_INSTANCE_FRAME =
  "DESKTOP_SECURITY_PRIMARY_SECOND_INSTANCE\n";
export const SECURITY_SMOKE_PRIMARY_SECOND_INSTANCE_FAILURE_FRAME =
  "DESKTOP_SECURITY_PRIMARY_SECOND_INSTANCE_FAILURE\n";

export const SECURITY_SMOKE_SHUTDOWN_STAGES = [
  "stdin-accepted",
  "residency-closed",
  "ipc-closed",
  "telegram-power-closed",
  "telegram-coordinator-closed",
  "daemon-closed",
  "exit-requested",
] as const;

export type SecuritySmokeShutdownStage = (typeof SECURITY_SMOKE_SHUTDOWN_STAGES)[number];

const SECURITY_SMOKE_CONTROL_PIPE_ARGUMENT = "--desktop-security-control-pipe=";
const SECURITY_SMOKE_CONTROL_PIPE_PREFIX = String.raw`\\.\pipe\enduragent-w17-`;

interface SecuritySmokeShutdownInput {
  readonly destroyed: boolean;
  readonly readable: boolean;
  on(event: "data", listener: (chunk: string) => void): unknown;
  once(event: "end" | "error", listener: () => void): unknown;
  removeListener(event: "data", listener: (chunk: string) => void): unknown;
  removeListener(event: "end" | "error", listener: () => void): unknown;
  resume(): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
}

interface SecuritySmokeStageOutput {
  readonly destroyed: boolean;
  readonly writable: boolean;
  once(event: "error", listener: () => void): unknown;
  removeListener(event: "error", listener: () => void): unknown;
  write(chunk: string, callback: (error?: Error | null) => void): unknown;
}

export function parseSecuritySmokeControlPipeArgument(args: readonly string[]): string {
  const matches = args.filter((value) => value.startsWith(SECURITY_SMOKE_CONTROL_PIPE_ARGUMENT));
  if (matches.length !== 1) throw new Error("security smoke control pipe argument was invalid");
  const path = matches[0]!.slice(SECURITY_SMOKE_CONTROL_PIPE_ARGUMENT.length);
  const candidate = path.slice(SECURITY_SMOKE_CONTROL_PIPE_PREFIX.length);
  if (
    path !== `${SECURITY_SMOKE_CONTROL_PIPE_PREFIX}${candidate}` ||
    !/^[A-Za-z0-9-]{1,64}$/u.test(candidate)
  ) {
    throw new Error("security smoke control pipe argument was invalid");
  }
  return path;
}

export function connectSecuritySmokeControlPipe(
  path: string,
  open: (path: string, listener: () => void) => Socket = (target, listener) =>
    connect(target, listener),
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let socket: Socket | undefined;
    let settled = false;
    const cleanup = () => socket?.removeListener("error", fail);
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket?.destroy();
      reject(new Error("security smoke control pipe connection failed"));
    };
    try {
      socket = open(path, () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(socket!);
      });
      socket.once("error", fail);
    } catch {
      fail();
    }
  });
}

export function waitForSecuritySmokeShutdown(input: SecuritySmokeShutdownInput): Promise<void> {
  if (input.destroyed || !input.readable) {
    return Promise.reject(new Error("security smoke shutdown input was unavailable"));
  }
  return new Promise((resolve, reject) => {
    let source = "";
    let settled = false;
    const cleanup = () => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      input.removeListener("end", onEnd);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };
    const onData = (chunk: string) => {
      if (settled) return;
      source += chunk;
      if (
        source.length > SECURITY_SMOKE_SHUTDOWN_FRAME.length ||
        !SECURITY_SMOKE_SHUTDOWN_FRAME.startsWith(source)
      ) {
        fail("security smoke shutdown frame was invalid");
      }
    };
    const onError = () => fail("security smoke shutdown input failed");
    const onEnd = () => {
      if (settled) return;
      if (source !== SECURITY_SMOKE_SHUTDOWN_FRAME) {
        fail("security smoke shutdown frame was invalid");
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    try {
      input.setEncoding("utf8");
      input.on("data", onData);
      input.once("error", onError);
      input.once("end", onEnd);
      input.resume();
    } catch {
      fail("security smoke shutdown input failed");
    }
  });
}

export function writeSecuritySmokeShutdownStage(
  output: SecuritySmokeStageOutput,
  stage: SecuritySmokeShutdownStage,
): Promise<void> {
  if (output.destroyed || !output.writable) {
    return Promise.reject(new Error("security smoke shutdown stage output was unavailable"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => output.removeListener("error", fail);
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("security smoke shutdown stage output failed"));
    };
    output.once("error", fail);
    try {
      output.write(`DESKTOP_SECURITY_STAGE ${stage}\n`, (error) => {
        if (settled) return;
        if (error) {
          fail();
          return;
        }
        settled = true;
        cleanup();
        resolve();
      });
    } catch {
      fail();
    }
  });
}

export function writeSecuritySmokeSecondInstance(output: SecuritySmokeStageOutput): Promise<void> {
  if (output.destroyed || !output.writable) {
    return Promise.reject(new Error("security smoke second instance output was unavailable"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => output.removeListener("error", fail);
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("security smoke second instance output failed"));
    };
    output.once("error", fail);
    try {
      output.write(SECURITY_SMOKE_SECOND_INSTANCE_FRAME, (error) => {
        if (settled) return;
        if (error) {
          fail();
          return;
        }
        settled = true;
        cleanup();
        resolve();
      });
    } catch {
      fail();
    }
  });
}

export function writeSecuritySmokePrimarySecondInstance(
  output: SecuritySmokeStageOutput,
): Promise<void> {
  if (output.destroyed || !output.writable) {
    return Promise.reject(
      new Error("security smoke primary second instance output was unavailable"),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => output.removeListener("error", fail);
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("security smoke primary second instance output failed"));
    };
    output.once("error", fail);
    try {
      output.write(SECURITY_SMOKE_PRIMARY_SECOND_INSTANCE_FRAME, (error) => {
        if (settled) return;
        if (error) {
          fail();
          return;
        }
        settled = true;
        cleanup();
        resolve();
      });
    } catch {
      fail();
    }
  });
}

export function writeSecuritySmokePrimarySecondInstanceFailure(
  output: SecuritySmokeStageOutput,
): Promise<void> {
  if (output.destroyed || !output.writable) {
    return Promise.reject(
      new Error("security smoke primary acknowledgment failure output was unavailable"),
    );
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => output.removeListener("error", fail);
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("security smoke primary acknowledgment failure output failed"));
    };
    output.once("error", fail);
    try {
      output.write(SECURITY_SMOKE_PRIMARY_SECOND_INSTANCE_FAILURE_FRAME, (error) => {
        if (settled) return;
        if (error) {
          fail();
          return;
        }
        settled = true;
        cleanup();
        resolve();
      });
    } catch {
      fail();
    }
  });
}
