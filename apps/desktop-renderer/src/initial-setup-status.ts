export function settleInitialSetupStatus(input: {
  readonly captureGeneration: () => Promise<number>;
  readonly open: () => Promise<void>;
  readonly markSettled: () => void;
  readonly reportSettled: (generation: number) => Promise<void>;
  readonly reportFailure: () => void;
}): void {
  let generation: Promise<number | undefined>;
  try {
    generation = input.captureGeneration().then(
      (value) => value,
      () => {
        input.reportFailure();
        return undefined;
      },
    );
  } catch {
    input.reportFailure();
    generation = Promise.resolve(undefined);
  }
  void input
    .open()
    .finally(() => {
      input.markSettled();
      void generation.then((value) => {
        if (value === undefined) return;
        void input.reportSettled(value).catch(input.reportFailure);
      });
    })
    .catch(() => {});
}
