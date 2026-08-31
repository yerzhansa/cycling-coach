import type { CredentialDraftPort, TransientPasswordInput } from "../onboarding/credentials";

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
  harvest(slots?: readonly string[]): readonly TransientPasswordInput[] {
    const wanted = slots === undefined ? null : new Set(slots);
    const carriers: TransientPasswordInput[] = [];
    for (const [slot, input] of inputs) {
      if (wanted !== null && !wanted.has(slot)) continue;
      carriers.push({ value: input.value, dataset: { slot } });
      input.value = "";
    }
    return carriers;
  },
  clear(): void {
    for (const input of inputs.values()) input.value = "";
  },
};
