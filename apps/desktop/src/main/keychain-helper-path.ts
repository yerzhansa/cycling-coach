import { isAbsolute, join } from "node:path";

export const KEYCHAIN_HELPER_EXECUTABLE_NAME = "keychain-helper" as const;
export const KEYCHAIN_HELPER_RESOURCE_DIRECTORY = "keychain" as const;
export const KEYCHAIN_HELPER_DEVELOPMENT_DIRECTORY = "dist/keychain-helper" as const;

export interface KeychainHelperLocation {
  readonly platform: NodeJS.Platform;
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly applicationPath: string;
}

export function resolveKeychainHelperPath(location: KeychainHelperLocation): string | undefined {
  if (location.platform !== "darwin") return undefined;
  const root = location.packaged
    ? join(location.resourcesPath, KEYCHAIN_HELPER_RESOURCE_DIRECTORY)
    : join(location.applicationPath, KEYCHAIN_HELPER_DEVELOPMENT_DIRECTORY);
  if (!isAbsolute(root)) return undefined;
  return join(root, KEYCHAIN_HELPER_EXECUTABLE_NAME);
}
