/**
 * Minimal config for constructing CyclingCoachAgent in tests. Uses the
 * openai-codex provider with empty apiKey so no real LLM is reachable.
 */
export function baseAgentConfig(dataDir: string) {
  return {
    llm: {
      provider: "openai-codex" as const,
      model: "gpt-5.4",
      apiKey: "",
      authProfile: "openai-codex",
    },
    intervals: { apiKey: "", athleteId: "0" },
    telegram: { botToken: "" },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
    },
    contextWindowTokens: 272_000,
    dataDir,
  };
}
