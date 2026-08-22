import type { CredentialEnvelopeRoots } from "./credential-envelope-inventory.js";
import {
  assertCredentialEnvelopeRootsStable,
  scanBoundCredentialEnvelopes,
} from "./credential-envelope-root-binding.js";
import type { CredentialEnvelopeLockProof } from "./credential-envelope-lock.js";
import type { KeychainKeyDeletion } from "./keychain-credential-encryption.js";
import type { KeychainBindingErrorCode } from "./keychain-binding.js";

export type KeychainKeyRetirement =
  | Readonly<{ status: "retained"; envelopes: number }>
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "already-absent" }>
  | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>;

export interface RetireKeychainKeyOptions extends CredentialEnvelopeRoots {
  readonly lockProof: CredentialEnvelopeLockProof;
  readonly deleteKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyDeletion>;
  readonly platform?: NodeJS.Platform;
}

export async function retireKeychainKeyWhenLastEnvelopeGone(
  options: RetireKeychainKeyOptions,
): Promise<KeychainKeyRetirement> {
  try {
    const { bindings, inventory } = await scanBoundCredentialEnvelopes(
      options,
      options.platform ?? process.platform,
    );
    if (inventory.deletionBlockers.length > 0) {
      return { status: "retained", envelopes: inventory.deletionBlockers.length };
    }
    await assertCredentialEnvelopeRootsStable(bindings);
    return await options.deleteKey(options.lockProof);
  } catch {
    return { status: "failed", code: "unknown" };
  }
}
