import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatStore } from "../src/agent/chat-store.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("decision session context", () => {
  it("repairs and deduplicates the structured tool exchange without a user answer message", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "decision-chat-context-"));
    dirs.push(dataDir);
    const store = new ChatStore(dataDir);
    const request = {
      question: "Choose tomorrow.",
      options: [
        {
          label: "Easy",
          description: "Recover.",
          recommended: true,
          consequence: "Tomorrow is easy.",
        },
        {
          label: "Tempo",
          description: "Keep tempo.",
          recommended: false,
          consequence: "Tomorrow keeps tempo.",
        },
      ],
    };
    const base = {
      chatId: "chat-1",
      decisionId: "decision-1",
      athleteText: "What should I do?",
      request,
    };
    store.persistDecisionContext(base);
    store.persistDecisionContext({
      ...base,
      result: {
        status: "answered",
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "easy" },
        consequence: "Tomorrow is easy.",
      },
      coachText: "Keep tomorrow easy.",
      continuationId: "continuation-1",
      lineage: {
        templateHash: "template",
        assembledHash: "assembled",
        provider: "openai-codex",
        model: "gpt-5.4",
        lineageVersion: "2",
      },
    });
    store.persistDecisionContext({
      ...base,
      result: {
        status: "answered",
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "easy" },
        consequence: "Tomorrow is easy.",
      },
      coachText: "Keep tomorrow easy.",
      continuationId: "continuation-1",
      lineage: {
        templateHash: "template",
        assembledHash: "assembled",
        provider: "openai-codex",
        model: "gpt-5.4",
        lineageVersion: "2",
      },
    });

    const { messages } = store.load("chat-1");
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1);
    store.overwriteHistory("chat-1", messages);
    store.persistDecisionContext({
      ...base,
      result: {
        status: "answered",
        decisionId: "decision-1",
        answer: { kind: "option", optionId: "easy" },
        consequence: "Tomorrow is easy.",
      },
      coachText: "Keep tomorrow easy.",
      continuationId: "continuation-1",
      lineage: {
        templateHash: "template",
        assembledHash: "assembled",
        provider: "openai-codex",
        model: "gpt-5.4",
        lineageVersion: "2",
      },
    });
    expect(store.load("chat-1").messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });
});
