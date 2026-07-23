import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODELS,
  LLM_MODEL_CATALOGUE,
  LLM_PROVIDERS,
  PROVIDER_BASE_URLS,
  resolveRuntimeConfig,
} from "../src/runtime-config.js";

describe("LLM model catalogue", () => {
  it("covers providers in setup order with every default among its advisory options", () => {
    expect(LLM_MODEL_CATALOGUE.map((entry) => entry.provider)).toEqual(LLM_PROVIDERS);
    for (const entry of LLM_MODEL_CATALOGUE) {
      expect(entry.defaultModel).toBe(DEFAULT_MODELS[entry.provider]);
      expect(entry.models.map((model) => model.value)).toContain(entry.defaultModel);
      expect(new Set(entry.models.map((model) => model.value)).size).toBe(entry.models.length);
    }
  });

  it("projects only the resolver's declared provider defaults", () => {
    for (const entry of LLM_MODEL_CATALOGUE) {
      expect(entry.defaultBaseUrl).toBe(
        PROVIDER_BASE_URLS[entry.provider as keyof typeof PROVIDER_BASE_URLS],
      );
    }
  });

  it("keeps the catalogue advisory by accepting a custom model", () => {
    expect(
      resolveRuntimeConfig({
        llm: {
          provider: "anthropic",
          model: "athlete-custom-model",
          apiKey: "obviously-fake-key",
        },
      }).llm.model,
    ).toBe("athlete-custom-model");
  });
});
