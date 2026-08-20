export const KEYCHAIN_HELPER_FILE: "keychain-helper";
export const KEYCHAIN_HELPER_BUILD_DIRECTORY: "dist/keychain-helper";
export const KEYCHAIN_HELPER_SOURCE: "native/keychain-helper/main.swift";
export const KEYCHAIN_HELPER_SWIFT_TARGET: "arm64-apple-macos12.0";
export const KEYCHAIN_HELPER_COMPILE_TIMEOUT_MS: number;

export function keychainHelperBuildPath(desktopRoot?: string): string;

export function keychainHelperCompilerAvailable(): boolean;

export function buildKeychainHelper(desktopRoot?: string): Promise<string | undefined>;
