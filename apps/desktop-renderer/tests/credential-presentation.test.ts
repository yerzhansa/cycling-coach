import { describe, expect, it } from "vitest";
import { credentialPresentation } from "../src/onboarding/credential-presentation.js";
import type { CredentialSlotStatus } from "../src/onboarding/machine.js";

describe("credential status presentation", () => {
  it("presents active, stored inactive, and failed credentials as distinct states", () => {
    const status = (
      runtimeState: "active" | "stored-inactive" | "failed",
    ): CredentialSlotStatus => ({ slot: "anthropic", state: "configured", runtimeState });

    expect(credentialPresentation(status("active"))).toEqual({
      className: "configured",
      copy: "Configured",
      retryable: false,
    });
    expect(credentialPresentation(status("stored-inactive"))).toEqual({
      className: "stored-inactive",
      copy: "Saved · Not in use",
      retryable: false,
    });
    expect(credentialPresentation(status("failed"))).toEqual({
      className: "failed",
      copy: "Saved · Retry",
      retryable: true,
    });
  });

  it("keeps a dormant API key non-alarming while ChatGPT is active", () => {
    const chatGpt = { state: "configured" as const, runtimeReady: true };
    const dormant: CredentialSlotStatus = {
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    };
    const presentation = credentialPresentation(dormant);

    expect(chatGpt).toEqual({ state: "configured", runtimeReady: true });
    expect(presentation.copy).toBe("Saved · Not in use");
    expect(presentation.retryable).toBe(false);
    expect(presentation.copy).not.toMatch(/error|failed|retry/iu);
  });
});
