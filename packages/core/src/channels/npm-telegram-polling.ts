export interface NpmTelegramPollingDependencies {
  readonly start: () => Promise<void>;
  readonly isShutdownLatched: () => boolean;
  readonly reportFatal: (error: unknown) => void | Promise<void>;
}

export async function startNpmTelegramPolling(
  dependencies: NpmTelegramPollingDependencies,
): Promise<void> {
  try {
    await dependencies.start();
  } catch (error) {
    if (dependencies.isShutdownLatched()) return;
    await dependencies.reportFatal(error);
  }
}
