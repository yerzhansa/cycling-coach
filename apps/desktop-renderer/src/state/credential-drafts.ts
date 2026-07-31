import type { CredentialDraftPort, TransientPasswordInput } from "../onboarding/credentials.js";

const inputs = new Map<string, HTMLInputElement>();

export function registerCredentialDraft(slot: string, input: HTMLInputElement | null): void {
  if (input === null) return;
  inputs.set(slot, input);
}

export function releaseCredentialDraft(slot: string, input: HTMLInputElement | null): void {
  if (input !== null) input.value = "";
  if (input === null || inputs.get(slot) === input) inputs.delete(slot);
}

export const credentialDrafts: CredentialDraftPort = {
  harvest(): readonly TransientPasswordInput[] {
    return Array.from(inputs, ([slot, input]) => {
      const carrier: TransientPasswordInput = { value: input.value, dataset: { slot } };
      input.value = "";
      return carrier;
    });
  },
  clear(): void {
    for (const input of inputs.values()) input.value = "";
  },
};
