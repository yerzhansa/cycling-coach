import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createAlibaba } from "@ai-sdk/alibaba";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

import { isPriced, priceUsage } from "./agent/codex/cost.js";

import type { Config } from "./config.js";
import { PROVIDER_BASE_URLS } from "./config.js";
import { codexGenerateText } from "./agent/codex-bridge.js";
import type { GenerateOpts, GenerateResult } from "./llm-types.js";
import { appendUsageLine, cacheTokenDetails, usageFieldsFromResult } from "./usage-ledger.js";

export type { GenerateOpts, GenerateResult } from "./llm-types.js";

// ============================================================================
// LLM DISPATCH
// ============================================================================

// Most providers cache the stable system prefix automatically server-side and
// get the plain system string, so they are absent here: direct openai/google,
// the OpenAI-compatible direct providers, and OpenRouter's OpenAI/DeepSeek/
// Grok/Moonshot routes. Explicit breakpoints are needed by direct Anthropic and
// — through OpenRouter — the Anthropic/Qwen/Gemini routes; of those we ship only
// the Qwen route (`qwen/`-namespaced ids), so `anthropic/` and `google/` via
// OpenRouter are intentionally out of scope and stay uncached. (Same breakpoint
// shape as Anthropic; only the providerOptions key differs —
// @openrouter/ai-sdk-provider reads it from message-level
// providerOptions.openrouter.cacheControl.)
export function cacheBreakpointKey(
  provider: string,
  model: string,
): "anthropic" | "openrouter" | undefined {
  if (provider === "anthropic") return "anthropic";
  if (provider === "openrouter" && model.startsWith("qwen/")) return "openrouter";
  return undefined;
}

export class LLM {
  private config: Config;
  private aiSdkModel: LanguageModel | null;
  // Provider + model are fixed for the instance, so resolve once whether this
  // configuration is in the vendored price catalog. A miss yields undefined cost
  // on the ledger (best-effort), never a fabricated figure.
  private priced: boolean;
  // Instance-constant for the same reason: the cache-breakpoint decision depends
  // only on provider + model, so resolve it once rather than per dispatch().
  private breakpointKey: "anthropic" | "openrouter" | undefined;

  constructor(config: Config) {
    this.config = config;
    this.aiSdkModel = config.llm.provider === "openai-codex" ? null : buildAiSdkModel(config);
    this.priced = isPriced(config.llm.provider, config.llm.model);
    this.breakpointKey = cacheBreakpointKey(config.llm.provider, config.llm.model);
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

    // The provider renders tools before system, so breakpointing the (only)
    // stable system block caches tools + system together. Which providers need a
    // breakpoint, and why the rest don't, lives on cacheBreakpointKey above.
    const breakpointKey = this.breakpointKey;
    const cachedSystem =
      breakpointKey !== undefined && opts.system !== undefined
        ? [
            {
              role: "system" as const,
              content: opts.system,
              providerOptions: { [breakpointKey]: { cacheControl: { type: "ephemeral" } } },
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
      cost: priceAiSdkUsage(this.config.llm.provider, this.config.llm.model, this.priced, result.totalUsage),
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

// The AI SDK reports token usage but no cost, so derive it from the vendored
// per-million price catalog (the same numbers the codex path prices against).
// `priced` is resolved once at construction; an uncatalogued configuration
// yields undefined rather than a fabricated figure (best-effort ledger).
function priceAiSdkUsage(
  provider: string,
  modelId: string,
  priced: boolean,
  totalUsage: GenerateResult["totalUsage"],
): GenerateResult["cost"] | undefined {
  if (!priced || !totalUsage) return undefined;
  const details = cacheTokenDetails(totalUsage);
  return priceUsage(provider, modelId, {
    input: totalUsage.inputTokens ?? 0,
    output: totalUsage.outputTokens ?? 0,
    cacheRead: details?.cacheReadTokens ?? 0,
    cacheWrite: details?.cacheWriteTokens ?? 0,
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
    case "deepseek": {
      // baseUrl is undefined only on direct construction (loadConfig always
      // resolves it); undefined lets the SDK fall back to its package default.
      const deepseek = createDeepSeek({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl });
      return deepseek(config.llm.model);
    }
    case "qwen": {
      const alibaba = createAlibaba({ apiKey: config.llm.apiKey, baseURL: config.llm.baseUrl });
      return alibaba(config.llm.model);
    }
    case "minimax": {
      // createOpenAICompatible requires a baseURL, so fall back to the shared
      // default when one wasn't resolved (direct construction in tests).
      const minimax = createOpenAICompatible({
        name: "minimax",
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl ?? PROVIDER_BASE_URLS.minimax,
      });
      return minimax(config.llm.model);
    }
    case "kimi": {
      const moonshot = createOpenAICompatible({
        name: "moonshot",
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl ?? PROVIDER_BASE_URLS.kimi,
      });
      return moonshot(config.llm.model);
    }
    case "zai": {
      const zai = createOpenAICompatible({
        name: "zai",
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl ?? PROVIDER_BASE_URLS.zai,
      });
      return zai(config.llm.model);
    }
    case "openrouter": {
      const openrouter = createOpenRouter({
        apiKey: config.llm.apiKey,
        baseURL: config.llm.baseUrl,
      });
      return openrouter.chat(config.llm.model);
    }
    case "openai-codex":
      throw new Error("openai-codex is handled via the bridge, not AI SDK");
  }
}
