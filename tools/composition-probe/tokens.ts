import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TOKEN_COUNT_MODEL } from "./constants.js";
import { buildMockPrompt } from "./assemble.js";
import { toAnthropicToolsJson } from "./tools.js";

export interface TokensJson {
  method: string;
  model: string;
  stablePrefixTokens: number;
  wholePromptTokens: number;
  measuredAtGitSha: string;
}

const COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";

async function countTokens(systemText: string, includeTools: boolean, apiKey: string): Promise<number> {
  const body = {
    model: TOKEN_COUNT_MODEL,
    system: [{ type: "text", text: systemText }],
    tools: includeTools ? toAnthropicToolsJson() : undefined,
    messages: [{ role: "user", content: "hi" }],
  };
  const res = await fetch(COUNT_TOKENS_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`count_tokens returned ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { input_tokens: number };
  return json.input_tokens;
}

function gitSha(): string {
  return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
}

export async function runTokensPhase(dir: string, apiKey: string): Promise<number> {
  const { block1, fullSystem } = buildMockPrompt();
  const stablePrefixTokens = await countTokens(block1, true, apiKey);
  const wholePromptTokens = await countTokens(fullSystem, true, apiKey);
  const out: TokensJson = {
    method: "anthropic count_tokens",
    model: TOKEN_COUNT_MODEL,
    stablePrefixTokens,
    wholePromptTokens,
    measuredAtGitSha: gitSha(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tokens.json"), JSON.stringify(out, null, 2) + "\n", "utf-8");
  return 0;
}
