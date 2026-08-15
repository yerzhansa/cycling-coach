export function settleInitialSetupStatus(input: {
  readonly captureGeneration: () => Promise<number>;
  readonly open: () => Promise<void>;
  readonly markSettled: () => void;
  readonly reportSettled: (generation: number) => Promise<void>;
  readonly reportFailure: () => void;
}): void {
  const generation = input.captureGeneration();
  void input
    .open()
    .finally(() => {
      input.markSettled();
      void generation.then(input.reportSettled).catch(input.reportFailure);
    })
    .catch(() => {});
}
