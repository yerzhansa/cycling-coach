import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

import { calculateCost, getModels } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";

import type { Config } from "./config.js";
import { codexGenerateText } from "./agent/codex-bridge.js";
import type { GenerateOpts, GenerateResult } from "./llm-types.js";
import { appendUsageLine, cacheTokenDetails, usageFieldsFromResult } from "./usage-ledger.js";

export type { GenerateOpts, GenerateResult } from "./llm-types.js";

// ============================================================================
// LLM DISPATCH
// ============================================================================

export class LLM {
  private config: Config;
  private aiSdkModel: LanguageModel | null;
  // Provider + model are fixed for the instance, so resolve the pricing model
  // once here. getModels() allocates a fresh array per call, so doing this in
  // generate() would re-scan the catalog on every LLM round-trip.
  private pricingModel: Model<Api> | null;

  constructor(config: Config) {
    this.config = config;
    this.aiSdkModel = config.llm.provider === "openai-codex" ? null : buildAiSdkModel(config);
    this.pricingModel =
      config.llm.provider === "openai-codex"
        ? null
        : (getModels(config.llm.provider).find((m) => m.id === config.llm.model) ?? null);
  }

  async generate(opts: GenerateOpts): Promise<GenerateResult> {
    const start = Date.now();
    const result = await this.dispatch(opts);
    const durationMs = Date.now() - start;
    this.recordGenerate(opts, result, durationMs);
    return result;
  }

  private async dispatch(opts: GenerateOpts): Promise<GenerateResult> {
    if (this.config.llm.provider === "openai-codex") {
      return await codexGenerateText({
        ...opts,
        modelId: this.config.llm.model,
        profileName: this.config.llm.authProfile ?? "openai-codex",
        stepLimit: opts.maxSteps,
      });
    }

    if (!this.aiSdkModel) {
      throw new Error("AI SDK model not initialized");
    }

    // Breakpoint on the last (only) stable system block; the provider renders
    // tools before system, so the marker caches tools + system together. The
    // cacheControl directive is Anthropic-specific — openai/google get the plain
    // system string. A second AI-SDK provider that needs prompt caching adds its
    // own branch here rather than extending this Anthropic-only one.
    const cachedSystem =
      this.config.llm.provider === "anthropic" && opts.system !== undefined
        ? [
            {
              role: "system" as const,
              content: opts.system,
              providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
            },
          ]
        : undefined;

    const base = {
      model: this.aiSdkModel,
      system: cachedSystem ?? opts.system,
      tools: opts.tools,
      stopWhen: opts.stopWhen,
      maxOutputTokens: opts.maxOutputTokens,
      maxRetries: 0,
    };
    const result = opts.prompt !== undefined
      ? await generateText({ ...base, prompt: opts.prompt })
      : await generateText({ ...base, messages: opts.messages ?? [] });

    return {
      text: result.text,
      toolCalls: result.toolCalls as GenerateResult["toolCalls"],
      finishReason: result.finishReason,
      usage: result.usage,
      totalUsage: result.totalUsage,
      steps: result.steps.length,
      cost: priceAiSdkUsage(this.pricingModel, result.totalUsage),
    };
  }

  private recordGenerate(opts: GenerateOpts, result: GenerateResult, durationMs: number): void {
    appendUsageLine(this.config.dataDir, {
      ts: Date.now(),
      kind: "generate",
      caller: opts.caller,
      provider: this.config.llm.provider,
      model: this.config.llm.model,
      durationMs,
      steps: result.steps,
      ...usageFieldsFromResult(result),
      stopReason: result.finishReason,
    });
  }
}

// The AI SDK reports token usage but no cost, so derive it from the same
// maintained model catalog the codex path already prices against. The model is
// resolved once at construction; codex carries its own provider-reported cost
// and is never re-priced here. An uncatalogued (null) model yields undefined
// rather than a fabricated figure (best-effort ledger).
function priceAiSdkUsage(
  model: Model<Api> | null,
  totalUsage: GenerateResult["totalUsage"],
): GenerateResult["cost"] | undefined {
  if (!model || !totalUsage) return undefined;
  const details = cacheTokenDetails(totalUsage);
  return calculateCost(model, {
    input: totalUsage.inputTokens ?? 0,
    output: totalUsage.outputTokens ?? 0,
    cacheRead: details?.cacheReadTokens ?? 0,
    cacheWrite: details?.cacheWriteTokens ?? 0,
    totalTokens: totalUsage.totalTokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
}

// ============================================================================
// AI SDK MODEL FACTORY
// ============================================================================

function buildAiSdkModel(config: Config): LanguageModel {
  switch (config.llm.provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey: config.llm.apiKey });
      return anthropic(config.llm.model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey: config.llm.apiKey });
      return openai(config.llm.model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey: config.llm.apiKey });
      return google(config.llm.model);
    }
    case "openai-codex":
      throw new Error("openai-codex is handled via the bridge, not AI SDK");
  }
}
