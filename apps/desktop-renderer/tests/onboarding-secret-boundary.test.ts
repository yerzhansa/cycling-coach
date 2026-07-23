import { describe, expect, it } from "vitest";
import { handoffCredential } from "../src/onboarding/mount.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("onboarding renderer secret boundary", () => {
  for (const [slot, sentinel] of [
    ["anthropic", "synthetic-model-secret-sentinel"],
    ["intervals-icu", "synthetic-intervals-secret-sentinel"],
  ] as const) {
    it(`releases the ${slot} password before the pending handoff settles`, async () => {
      const input = { value: sentinel, dataset: { slot } };
      const gate = deferred();
      let transient: { readonly slot: string; readonly value: string } | undefined;
      const write = async (value: { readonly slot: string; readonly value: string }) => {
        try {
          transient = value;
          await gate.promise;
        } finally {
          transient = undefined;
        }
      };
      const pending = handoffCredential(input, write);
      expect(input.value).toBe("");
      expect(transient).toEqual({ slot, value: sentinel });
      gate.resolve();
      await pending;
      expect(input.value).toBe("");
      expect(transient).toBeUndefined();
      const capturedSurfaces = {
        innerHTML: "",
        outerHTML: '<input type="password">',
        text: "",
        attributes: ["type=password"],
        snapshot: { input: "" },
        location: "enduragent://app/index.html",
        console: [],
        bridgeResult: { slot, status: "configured", runtimeReady: true },
        rpc: [],
        browserStorage: [],
      };
      expect(JSON.stringify(capturedSurfaces)).not.toContain(sentinel);
    });
  }

  it("clears the live control when the privileged handoff rejects", async () => {
    const sentinel = "synthetic-refused-secret-sentinel";
    const input = { value: sentinel, dataset: { slot: "openrouter" } };
    await expect(
      handoffCredential(input, async () => {
        throw new TypeError();
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(input.value).toBe("");
    expect(JSON.stringify(input)).not.toContain(sentinel);
  });
});
