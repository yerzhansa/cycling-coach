import { vi } from "vitest";

export interface ScriptedAnswers {
  selects?: unknown[];
  passwords?: string[];
  texts?: string[];
  confirms?: boolean[];
}

/**
 * Returns a drop-in `vi.doMock` factory for `@clack/prompts` that replays
 * pre-scripted answers per prompt type. Use in setup-wizard tests.
 */
export function scriptedPrompts(answers: ScriptedAnswers) {
  const selects = answers.selects ?? [];
  const passwords = answers.passwords ?? [];
  const texts = answers.texts ?? [];
  const confirms = answers.confirms ?? [];
  let s = 0;
  let p = 0;
  let t = 0;
  let c = 0;
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    log: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
    note: vi.fn(),
    isCancel: () => false,
    select: vi.fn(async () => selects[s++]),
    password: vi.fn(async () => passwords[p++]),
    text: vi.fn(async () => texts[t++]),
    confirm: vi.fn(async () => confirms[c++]),
  };
}
