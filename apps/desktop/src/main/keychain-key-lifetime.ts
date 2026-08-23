import type { CredentialEnvelopeLockProof } from "./credential-envelope-lock.js";
import type { KeychainKeyRetirement } from "./automatic-key-retirement.js";

export type { KeychainKeyRetirement } from "./automatic-key-retirement.js";

export interface RetireKeychainKeyOptions {
  readonly lockProof: CredentialEnvelopeLockProof;
  readonly retireKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyRetirement>;
}

export async function retireKeychainKeyWhenLastEnvelopeGone(
  options: RetireKeychainKeyOptions,
): Promise<KeychainKeyRetirement> {
  try {
    return await options.retireKey(options.lockProof);
  } catch {
    return { status: "failed", code: "unknown" };
  }
}
