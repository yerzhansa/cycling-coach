export const DISPOSABLE_SAFE_STORAGE_CONTEXT_ENV = "ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT";

export function isDisposableSafeStorageContext(environment = process.env) {
  return environment.CI === "true" || environment[DISPOSABLE_SAFE_STORAGE_CONTEXT_ENV] === "1";
}

export function requireDisposableSafeStorageContext(
  environment = process.env,
  platform = process.platform,
) {
  if (platform !== "darwin") {
    throw new TypeError("packaged Safe Storage verification requires macOS");
  }
  if (!isDisposableSafeStorageContext(environment)) {
    throw new TypeError(
      `packaged Safe Storage verification requires CI or ${DISPOSABLE_SAFE_STORAGE_CONTEXT_ENV}=1 in a disposable macOS user`,
    );
  }
}
