export interface KeychainCommandResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type KeychainCommandEnvironment = Readonly<NodeJS.ProcessEnv> & {
  readonly HOME: string;
};

export type RunKeychainCommand = (
  args: readonly string[],
  options: { readonly environment: KeychainCommandEnvironment },
) => Promise<KeychainCommandResult>;

export interface DisposableKeychain {
  readonly home: string;
  readonly recoveryPath: string;
  activate(): Promise<void>;
  restore(): Promise<void>;
  restored(): boolean;
}

function succeeded(result: KeychainCommandResult): boolean {
  return result.code === 0 && result.signal === null;
}

function requireSuccess(result: KeychainCommandResult): void {
  if (!succeeded(result)) throw new TypeError("disposable keychain command failed");
}

function quotedPaths(value: Buffer): readonly string[] {
  const source = value.toString("utf8");
  const paths = [...source.matchAll(/"([^"\r\n]+)"/gu)].map((match) => match[1]);
  if (source.replaceAll(/"[^"\r\n]+"/gu, "").trim() !== "") {
    throw new TypeError("keychain state output is invalid");
  }
  return paths;
}

function requireNoDefault(result: KeychainCommandResult): void {
  if (result.code !== 1 || result.signal !== null || result.stdout.length !== 0) {
    throw new TypeError("disposable keychain HOME has an unexpected default keychain");
  }
}

function requireEmptySearch(result: KeychainCommandResult): void {
  requireSuccess(result);
  if (quotedPaths(result.stdout).length !== 0) {
    throw new TypeError("disposable keychain HOME has an unexpected search list");
  }
}

function requireExactActiveState(
  defaultResult: KeychainCommandResult,
  searchResult: KeychainCommandResult,
  expectedPath: string,
): void {
  requireSuccess(defaultResult);
  requireSuccess(searchResult);
  const defaultPaths = quotedPaths(defaultResult.stdout);
  const searchPaths = quotedPaths(searchResult.stdout);
  if (
    defaultPaths.length !== 1 ||
    defaultPaths[0] !== expectedPath ||
    searchPaths.length !== 1 ||
    searchPaths[0] !== expectedPath
  ) {
    throw new TypeError("disposable keychain activation state is invalid");
  }
}

export async function prepareDisposableKeychain(input: {
  readonly home: string;
  readonly path: string;
  readonly password: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly run: RunKeychainCommand;
}): Promise<DisposableKeychain> {
  const environment = Object.freeze({ ...input.environment, HOME: input.home });
  const run = (args: readonly string[]): Promise<KeychainCommandResult> =>
    input.run(args, { environment });
  const verifyVirginState = async (): Promise<void> => {
    const defaultResult = await run(["default-keychain", "-d", "user"]);
    const searchResult = await run(["list-keychains", "-d", "user"]);
    requireNoDefault(defaultResult);
    requireEmptySearch(searchResult);
  };

  await verifyVirginState();
  let created = false;
  let deleted = false;
  let active = false;
  let restorationComplete = false;

  const restore = async (): Promise<void> => {
    if (restorationComplete) return;
    const preferenceErrors: unknown[] = [];
    for (const args of [
      ["default-keychain", "-d", "user", "-s"],
      ["list-keychains", "-d", "user", "-s"],
    ]) {
      try {
        requireSuccess(await run(args));
      } catch (error) {
        preferenceErrors.push(error);
      }
    }
    if (preferenceErrors.length > 0) {
      throw new AggregateError(
        preferenceErrors,
        `keychain restoration failed; recovery retained at ${input.path}`,
      );
    }
    if (created && !deleted) {
      try {
        requireSuccess(await run(["delete-keychain", input.path]));
        deleted = true;
      } catch (error) {
        throw new AggregateError(
          [error],
          `keychain deletion failed; recovery retained at ${input.path}`,
        );
      }
    }
    try {
      await verifyVirginState();
    } catch (error) {
      throw new AggregateError(
        [error],
        `keychain restoration verification failed; recovery retained at ${input.path}`,
      );
    }
    restorationComplete = true;
    active = false;
  };

  return {
    home: input.home,
    recoveryPath: input.path,
    async activate() {
      if (active) return;
      if (restorationComplete) throw new TypeError("disposable keychain was already restored");
      try {
        requireSuccess(await run(["create-keychain", "-p", input.password, input.path]));
        created = true;
        deleted = false;
        requireSuccess(await run(["unlock-keychain", "-p", input.password, input.path]));
        requireSuccess(await run(["set-keychain-settings", "-lut", "21600", input.path]));
        requireSuccess(await run(["list-keychains", "-d", "user", "-s", input.path]));
        requireSuccess(await run(["default-keychain", "-d", "user", "-s", input.path]));
        const defaultResult = await run(["default-keychain", "-d", "user"]);
        const searchResult = await run(["list-keychains", "-d", "user"]);
        requireExactActiveState(defaultResult, searchResult, input.path);
        active = true;
      } catch (error) {
        try {
          await restore();
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `disposable keychain setup failed; recovery retained at ${input.path}`,
          );
        }
        throw error;
      }
    },
    restore,
    restored: () => restorationComplete,
  };
}
