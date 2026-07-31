import { describe, expect, it } from "vitest";

import { isS8aProvider, PROVIDER_LANES, providerLane, supportedProviderList } from "./provider-lane.js";
import { S8A_PROVIDERS } from "./types.js";

describe("s8a provider lanes", () => {
  it("carries a lane for every declared provider", () => {
    expect(Object.keys(PROVIDER_LANES).sort()).toEqual([...S8A_PROVIDERS].sort());
    for (const provider of S8A_PROVIDERS) {
      const lane = providerLane(provider);
      expect(lane.provider).toBe(provider);
      expect(lane.defaultRecordModel).not.toBe("");
      expect(lane.recordBypassHosts.length).toBeGreaterThan(0);
    }
  });

  it("pins each lane's credential kind", () => {
    expect(providerLane("anthropic").credential).toBe("api-key");
    expect(providerLane("openai-codex").credential).toBe("oauth-profile");
  });

  it("accepts only the supported provider strings", () => {
    expect(isS8aProvider("anthropic")).toBe(true);
    expect(isS8aProvider("openai-codex")).toBe(true);
    expect(isS8aProvider("openai")).toBe(false);
    expect(isS8aProvider("constructor")).toBe(false);
    expect(isS8aProvider(undefined)).toBe(false);
    expect(isS8aProvider(7)).toBe(false);
  });

  it("renders the supported list for harness error messages", () => {
    expect(supportedProviderList()).toBe("anthropic | openai-codex");
  });
});
