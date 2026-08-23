import type { CredentialEnvelopeLockProof } from "./credential-envelope-lock.js";
import type { CredentialEnvelopeRoots } from "./credential-envelope-inventory.js";
import { scanBoundCredentialEnvelopes } from "./credential-envelope-root-binding.js";
import type { KeychainBindingErrorCode } from "./keychain-binding.js";

const zeroDeletionBlockerCensusProof = Symbol("zero-deletion-blocker-census-proof");

export interface ZeroDeletionBlockerCensusProof {
  readonly [zeroDeletionBlockerCensusProof]: true;
  readonly lockProof: CredentialEnvelopeLockProof;
}

export type AutomaticKeyRetirementInspection =
  | Readonly<{
      status: "inspected";
      deletionBlockers: number;
      keychainDependents: number;
      unverified: number;
      zeroProof: ZeroDeletionBlockerCensusProof | null;
    }>
  | Readonly<{ status: "failed" }>;

export type InspectAutomaticKeyRetirement = (
  proof: CredentialEnvelopeLockProof,
) => Promise<AutomaticKeyRetirementInspection>;

export type KeychainKeyRetirement =
  | Readonly<{ status: "retained"; envelopes: number }>
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "already-absent" }>
  | Readonly<{ status: "failed"; code: KeychainBindingErrorCode }>;

export function createAutomaticKeyRetirementInspector(
  roots: CredentialEnvelopeRoots,
  platform: NodeJS.Platform = process.platform,
): InspectAutomaticKeyRetirement {
  return async (lockProof) => {
    try {
      const { inventory } = await scanBoundCredentialEnvelopes(roots, platform);
      const deletionBlockers = inventory.deletionBlockers.length;
      return {
        status: "inspected",
        deletionBlockers,
        keychainDependents: inventory.keychainDependents,
        unverified: inventory.unverified,
        zeroProof:
          deletionBlockers === 0
            ? Object.freeze({
                [zeroDeletionBlockerCensusProof]: true as const,
                lockProof,
              })
            : null,
      };
    } catch {
      return { status: "failed" };
    }
  };
}

export function isZeroDeletionBlockerCensusProof(
  proof: ZeroDeletionBlockerCensusProof,
  lockProof: CredentialEnvelopeLockProof,
): boolean {
  return proof[zeroDeletionBlockerCensusProof] === true && proof.lockProof === lockProof;
}
