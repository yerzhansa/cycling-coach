import type { OnboardingCredentialWriteInput, OnboardingLlmSelection } from "./bridge";

export interface TransientPasswordInput {
  value: string;
  readonly dataset: { readonly slot?: string };
}

export interface CredentialDraftPort {
  harvest(slots?: readonly string[]): readonly TransientPasswordInput[];
  clear(): void;
}

export async function handoffCredential(
  input: TransientPasswordInput,
  write: (value: OnboardingCredentialWriteInput) => Promise<unknown>,
  selection?: OnboardingLlmSelection,
): Promise<boolean> {
  let secret: string | undefined;
  try {
    secret = input.value;
    input.value = "";
    if (secret.trim().length === 0) return false;
    await write({
      slot: input.dataset.slot as OnboardingCredentialWriteInput["slot"],
      value: secret,
      ...(selection === undefined ? {} : { selection }),
    });
    return true;
  } finally {
    input.value = "";
    secret = undefined;
  }
}
