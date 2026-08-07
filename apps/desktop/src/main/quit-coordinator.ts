import type { DesktopUpdateController } from "./update-controller.js";

export interface DesktopBeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopTerminationSignalSource {
  on(event: "SIGTERM", listener: () => void): unknown;
}

export function installDesktopTerminationSignalHandler(input: {
  readonly signalSource: DesktopTerminationSignalSource;
  readonly requestQuit: () => void;
}): void {
  let quitRequested = false;
  const requestQuit = (): void => {
    if (quitRequested) return;
    quitRequested = true;
    input.requestQuit();
  };
  input.signalSource.on("SIGTERM", requestQuit);
}

export async function completeDesktopShutdown(input: {
  readonly drain: () => Promise<void>;
  readonly updateController: Pick<DesktopUpdateController, "completeInstallAfterDrain">;
  readonly allowFinalQuit: () => void;
  readonly exit: (code: number) => void;
}): Promise<void> {
  try {
    await input.drain();
  } catch {
    input.exit(1);
    return;
  }
  let updateInstall: "started" | "not-requested" | "failed";
  try {
    updateInstall = input.updateController.completeInstallAfterDrain(input.allowFinalQuit);
  } catch {
    input.exit(1);
    return;
  }
  if (updateInstall === "started") return;
  if (updateInstall === "failed") {
    input.exit(1);
    return;
  }
  input.allowFinalQuit();
  input.exit(0);
}

export function createDesktopQuitCoordinator(input: {
  readonly drain: () => Promise<void>;
  readonly updateController: Pick<DesktopUpdateController, "completeInstallAfterDrain">;
  readonly exit: (code: number) => void;
}): {
  readonly beforeQuit: (event: DesktopBeforeQuitEvent) => "allowed" | "draining";
} {
  let drainPromise: Promise<void> | undefined;
  let finalQuitAllowed = false;
  return {
    beforeQuit(event) {
      if (finalQuitAllowed) return "allowed";
      event.preventDefault();
      drainPromise ??= completeDesktopShutdown({
        ...input,
        allowFinalQuit: () => {
          finalQuitAllowed = true;
        },
      });
      return "draining";
    },
  };
}
