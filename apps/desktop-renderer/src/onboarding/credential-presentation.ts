import type { CredentialSlotStatus } from "./machine.js";

export interface CredentialPresentation {
  readonly className: string;
  readonly copy: string;
  readonly retryable: boolean;
}

export function credentialPresentation(status: CredentialSlotStatus): CredentialPresentation {
  if (status.state === "missing") {
    return { className: "", copy: "Not configured", retryable: false };
  }
  if (status.state === "re-prompt") {
    return { className: "re-prompt", copy: "Enter again", retryable: false };
  }
  if (status.runtimeState === "active") {
    return { className: "configured", copy: "Configured", retryable: false };
  }
  if (status.runtimeState === "stored-inactive") {
    return { className: "stored-inactive", copy: "Saved · Not in use", retryable: false };
  }
  return { className: "failed", copy: "Saved · Retry", retryable: true };
}
