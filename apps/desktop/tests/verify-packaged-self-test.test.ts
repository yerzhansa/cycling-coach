import { describe, expect, it } from "vitest";
import { shouldPrepareDevelopmentPackage } from "../scripts/verify-packaged-self-test.mjs";

describe("packaged self-test preparation", () => {
  it("builds by default and reuses an explicitly prepared package", () => {
    expect(shouldPrepareDevelopmentPackage([])).toBe(true);
    expect(shouldPrepareDevelopmentPackage(["--prepared-package"])).toBe(false);
  });

  it.each([{ arguments_: ["--unknown"] }, { arguments_: ["--prepared-package", "extra"] }])(
    "rejects unsupported arguments $arguments_",
    ({ arguments_ }) => {
      expect(() => shouldPrepareDevelopmentPackage(arguments_)).toThrow(
        "arguments are not supported",
      );
    },
  );
});
