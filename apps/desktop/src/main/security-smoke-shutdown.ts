export const SECURITY_SMOKE_SHUTDOWN_FRAME = "shutdown\n";
export const SECURITY_SMOKE_SECOND_INSTANCE_FRAME = "DESKTOP_SECURITY_SECOND_INSTANCE\n";
export const SECURITY_SMOKE_PRIMARY_SECOND_INSTANCE_FRAME =
  "DESKTOP_SECURITY_PRIMARY_SECOND_INSTANCE\n";

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
