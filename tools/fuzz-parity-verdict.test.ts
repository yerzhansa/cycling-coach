import { describe, expect, it } from "vitest";

import { decideVerdict } from "./fuzz-parity-verdict";

describe("decideVerdict — the harness must never report a vacuous pass", () => {
  it("passes ONLY when the differential ran clean on real inputs", () => {
    expect(
      decideVerdict({ compared: 5000, oracleErrors: 0, contractViolations: 0, mismatchTotal: 0 }),
    ).toEqual({ code: 0, status: "ok" });
  });

  it("fails when the oracle threw on every input (the reported false-green: 0 compared → exit 0)", () => {
    const v = decideVerdict({
      compared: 0,
      oracleErrors: 5000,
      contractViolations: 0,
      mismatchTotal: 0,
    });
    expect(v.status).toBe("oracle-error");
    expect(v.code).not.toBe(0);
  });

  it("fails on a partial-error run that previously printed OK across a handful of fixtures", () => {
    const v = decideVerdict({
      compared: 10,
      oracleErrors: 4990,
      contractViolations: 0,
      mismatchTotal: 0,
    });
    expect(v.status).toBe("oracle-error");
    expect(v.code).not.toBe(0);
  });

  it("fails on even a single oracle error (strict any-error-fails)", () => {
    expect(
      decideVerdict({ compared: 4999, oracleErrors: 1, contractViolations: 0, mismatchTotal: 0 })
        .code,
    ).not.toBe(0);
  });

  it("fails on a contract violation — a silent-None input gives a false parity, not a clean pass", () => {
    const v = decideVerdict({
      compared: 4999,
      oracleErrors: 0,
      contractViolations: 1,
      mismatchTotal: 0,
    });
    expect(v).toEqual({ code: 2, status: "contract-violation" });
  });

  it("lets an oracle error outrank a contract violation — fix the broken oracle first", () => {
    expect(
      decideVerdict({ compared: 100, oracleErrors: 1, contractViolations: 1, mismatchTotal: 0 })
        .status,
    ).toBe("oracle-error");
  });

  it("lets a contract violation outrank a mismatch — a mismatch on an untrustworthy input is meaningless", () => {
    expect(
      decideVerdict({ compared: 100, oracleErrors: 0, contractViolations: 1, mismatchTotal: 5 })
        .status,
    ).toBe("contract-violation");
  });

  it("fails on an empty run (e.g. --n=0) — nothing proven is not a pass", () => {
    expect(
      decideVerdict({ compared: 0, oracleErrors: 0, contractViolations: 0, mismatchTotal: 0 }),
    ).toEqual({ code: 2, status: "empty" });
  });

  it("reports metric mismatches as a divergence (exit 1)", () => {
    expect(
      decideVerdict({ compared: 5000, oracleErrors: 0, contractViolations: 0, mismatchTotal: 3 }),
    ).toEqual({ code: 1, status: "mismatch" });
  });

  it("lets an oracle error mask mismatches — a broken oracle invalidates the whole run", () => {
    expect(
      decideVerdict({ compared: 4000, oracleErrors: 1000, contractViolations: 0, mismatchTotal: 7 })
        .status,
    ).toBe("oracle-error");
  });

  it("invariant: code 0 IFF every failure counter is clear and at least one fixture compared", () => {
    for (const compared of [0, 1, 100]) {
      for (const oracleErrors of [0, 1, 50]) {
        for (const contractViolations of [0, 1, 50]) {
          for (const mismatchTotal of [0, 1, 9]) {
            const v = decideVerdict({ compared, oracleErrors, contractViolations, mismatchTotal });
            const shouldPass =
              oracleErrors === 0 &&
              contractViolations === 0 &&
              mismatchTotal === 0 &&
              compared > 0;
            expect(v.code === 0).toBe(shouldPass);
            // Precedence: oracle-error > contract-violation > mismatch > empty > ok.
            const expectedStatus =
              oracleErrors > 0
                ? "oracle-error"
                : contractViolations > 0
                  ? "contract-violation"
                  : mismatchTotal > 0
                    ? "mismatch"
                    : compared === 0
                      ? "empty"
                      : "ok";
            expect(v.status).toBe(expectedStatus);
          }
        }
      }
    }
  });
});
