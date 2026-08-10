import { describe, expect, it, vi } from "vitest";
import {
  prepareDisposableKeychain,
  type KeychainCommandEnvironment,
  type KeychainCommandResult,
  type RunKeychainCommand,
} from "../scripts/support/packaged-telegram/disposable-keychain.js";

const operatorHome = "/tmp/acceptance-home";
const disposable = `${operatorHome}/Library/Keychains/acceptance.keychain-db`;
const login = "/Users/athlete/Library/Keychains/login.keychain-db";

function success(stdout = ""): KeychainCommandResult {
  return {
    code: 0,
    signal: null,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
}

function noDefault(
  diagnostic = "security: SecKeychainCopyDefault: A default keychain could not be found.\n",
): KeychainCommandResult {
  return {
    code: 1,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from(diagnostic),
  };
}

function failure(): KeychainCommandResult {
  return {
    code: 1,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.from("synthetic failure\n"),
  };
}

function commandHarness(
  input: {
    readonly defaultPath?: string | null;
    readonly searchPaths?: readonly string[];
    readonly noDefaultDiagnostic?: string;
  } = {},
) {
  const calls: {
    readonly args: readonly string[];
    readonly environment: KeychainCommandEnvironment;
  }[] = [];
  let defaultPath = input.defaultPath ?? null;
  let searchPaths = [...(input.searchPaths ?? [])];
  let created = false;
  let failDefaultClear = false;
  let failDelete = false;
  let failDefaultVerificationWith: string | undefined;
  const run = vi.fn(
    async (
      args: readonly string[],
      options: { readonly environment: KeychainCommandEnvironment },
    ): Promise<KeychainCommandResult> => {
      calls.push({ args: [...args], environment: { ...options.environment } });
      if (options.environment.HOME !== operatorHome) return failure();
      if (args[0] === "default-keychain" && !args.includes("-s")) {
        if (failDefaultVerificationWith !== undefined) {
          defaultPath = failDefaultVerificationWith;
          failDefaultVerificationWith = undefined;
        }
        return defaultPath === null
          ? noDefault(input.noDefaultDiagnostic)
          : success(`"${defaultPath}"\n`);
      }
      if (args[0] === "list-keychains" && !args.includes("-s")) {
        return success(searchPaths.map((path) => `    "${path}"`).join("\n"));
      }
      if (args[0] === "create-keychain") {
        created = true;
        return success();
      }
      if (args[0] === "unlock-keychain" || args[0] === "set-keychain-settings") {
        return created ? success() : failure();
      }
      if (args[0] === "default-keychain" && args.includes("-s")) {
        if (args.length === 4 && failDefaultClear) {
          failDefaultClear = false;
          return failure();
        }
        defaultPath = args[4] ?? null;
        return success();
      }
      if (args[0] === "list-keychains" && args.includes("-s")) {
        searchPaths = args.slice(4);
        return success();
      }
      if (args[0] === "delete-keychain") {
        if (failDelete) {
          failDelete = false;
          return failure();
        }
        if (!created) return failure();
        created = false;
        return success();
      }
      return failure();
    },
  ) as RunKeychainCommand;
  return {
    calls,
    run,
    state: () => ({ defaultPath, searchPaths: [...searchPaths], created }),
    failNextDefaultClear: () => {
      failDefaultClear = true;
    },
    failNextDelete: () => {
      failDelete = true;
    },
    failNextDefaultVerification: (path: string) => {
      failDefaultVerificationWith = path;
    },
  };
}

async function prepared(commands = commandHarness()) {
  const keychain = await prepareDisposableKeychain({
    home: operatorHome,
    path: disposable,
    password: "password",
    environment: {
      HOME: "/Users/athlete",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
    },
    run: commands.run,
  });
  return { commands, keychain };
}

describe("disposable keychain", () => {
  it("activates and restores an exact virgin HOME without reading another HOME", async () => {
    const { commands, keychain } = await prepared();

    await keychain.activate();
    expect(commands.state()).toEqual({
      defaultPath: disposable,
      searchPaths: [disposable],
      created: true,
    });
    expect(commands.calls.every((call) => call.environment.HOME === operatorHome)).toBe(true);
    expect(
      commands.calls.every(
        (call) =>
          call.environment.PATH === "/usr/bin:/bin" && call.environment.LANG === "en_US.UTF-8",
      ),
    ).toBe(true);

    await keychain.restore();
    expect(keychain.restored()).toBe(true);
    expect(commands.state()).toEqual({ defaultPath: null, searchPaths: [], created: false });
    expect(commands.calls.slice(-5).map((call) => call.args)).toEqual([
      ["default-keychain", "-d", "user", "-s"],
      ["list-keychains", "-d", "user", "-s"],
      ["delete-keychain", disposable],
      ["default-keychain", "-d", "user"],
      ["list-keychains", "-d", "user"],
    ]);
  });

  it("accepts a localized missing-default diagnostic for a virgin HOME", async () => {
    const { keychain } = await prepared(
      commandHarness({
        noDefaultDiagnostic: "security: kein Standardschl\u00fcsselbund gefunden\n",
      }),
    );

    await keychain.activate();
    await keychain.restore();
    expect(keychain.restored()).toBe(true);
  });

  it.each([
    { defaultPath: login, searchPaths: [] },
    { defaultPath: null, searchPaths: [login] },
  ])("fails closed when the temporary HOME is not virgin: %o", async (state) => {
    const commands = commandHarness(state);

    await expect(
      prepareDisposableKeychain({
        home: operatorHome,
        path: disposable,
        password: "password",
        environment: process.env,
        run: commands.run,
      }),
    ).rejects.toThrow(/unexpected/u);
    expect(commands.calls.some((call) => call.args[0] === "create-keychain")).toBe(false);
  });

  it("retains the keychain when preference restoration fails and retries idempotently", async () => {
    const { commands, keychain } = await prepared();
    await keychain.activate();
    commands.failNextDefaultClear();

    await expect(keychain.restore()).rejects.toThrow(`recovery retained at ${disposable}`);
    expect(keychain.restored()).toBe(false);
    expect(commands.state().created).toBe(true);

    await keychain.restore();
    expect(keychain.restored()).toBe(true);
    expect(commands.state()).toEqual({ defaultPath: null, searchPaths: [], created: false });
  });

  it("retries deletion without marking restoration complete", async () => {
    const { commands, keychain } = await prepared();
    await keychain.activate();
    commands.failNextDelete();

    await expect(keychain.restore()).rejects.toThrow(`recovery retained at ${disposable}`);
    expect(keychain.restored()).toBe(false);
    expect(commands.state()).toEqual({ defaultPath: null, searchPaths: [], created: true });

    await keychain.restore();
    expect(keychain.restored()).toBe(true);
    expect(commands.state()).toEqual({ defaultPath: null, searchPaths: [], created: false });
  });

  it("retries failed virgin-state postconditions after deletion", async () => {
    const { commands, keychain } = await prepared();
    await keychain.activate();
    commands.failNextDefaultVerification(login);

    await expect(keychain.restore()).rejects.toThrow(`recovery retained at ${disposable}`);
    expect(keychain.restored()).toBe(false);
    expect(commands.state()).toEqual({ defaultPath: login, searchPaths: [], created: false });

    await keychain.restore();
    expect(keychain.restored()).toBe(true);
    expect(commands.state()).toEqual({ defaultPath: null, searchPaths: [], created: false });
  });
});
