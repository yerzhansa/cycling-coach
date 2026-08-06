import { describe, expect, it } from "vitest";
import {
  DISPOSABLE_SAFE_STORAGE_CONTEXT_ENV,
  isDisposableSafeStorageContext,
  requireDisposableSafeStorageContext,
} from "../smoke/safe-storage-test-context.mjs";

describe("packaged Safe Storage test context", () => {
  it("accepts only an explicit disposable marker or CI", () => {
    expect(isDisposableSafeStorageContext({})).toBe(false);
    expect(isDisposableSafeStorageContext({ CI: "1" })).toBe(false);
    expect(isDisposableSafeStorageContext({ CI: "true" })).toBe(true);
    expect(isDisposableSafeStorageContext({ [DISPOSABLE_SAFE_STORAGE_CONTEXT_ENV]: "1" })).toBe(
      true,
    );
    expect(isDisposableSafeStorageContext({ [DISPOSABLE_SAFE_STORAGE_CONTEXT_ENV]: "true" })).toBe(
      false,
    );
  });

  it("fails closed outside a disposable macOS context", () => {
    expect(() => requireDisposableSafeStorageContext({}, "darwin")).toThrow(
      DISPOSABLE_SAFE_STORAGE_CONTEXT_ENV,
    );
    expect(() =>
      requireDisposableSafeStorageContext({ [DISPOSABLE_SAFE_STORAGE_CONTEXT_ENV]: "1" }, "linux"),
    ).toThrow("requires macOS");
    expect(() => requireDisposableSafeStorageContext({ CI: "true" }, "darwin")).not.toThrow();
  });
});
