import type { CredentialEnvelopeLockProof } from "./credential-envelope-lock.js";
import {
  scanCredentialEnvelopes,
  type CredentialEnvelopeRoots,
} from "./credential-envelope-inventory.js";
import {
  assertCredentialEnvelopeRootsStable,
  bindCredentialEnvelopeRoots,
  guardedCredentialEnvelopeRoots,
  useBoundCredentialRoot,
} from "./credential-envelope-root-binding.js";
import { syncDirectory } from "./durable-atomic-replace.js";
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
  | Readonly<{
      status: "failed";
      code: KeychainBindingErrorCode;
      keyCleanupPending: boolean;
    }>;

export interface AutomaticKeyRetirementInspectorOptions {
  readonly syncDirectory?: (root: string) => Promise<void>;
}

export function createAutomaticKeyRetirementInspector(
  roots: CredentialEnvelopeRoots,
  platform: NodeJS.Platform = process.platform,
  options: AutomaticKeyRetirementInspectorOptions = {},
): InspectAutomaticKeyRetirement {
  const synchronizeDirectory =
    options.syncDirectory ?? (platform === "win32" ? async () => undefined : syncDirectory);
  return async (lockProof) => {
    try {
      const bindings = await bindCredentialEnvelopeRoots(roots, platform);
      for (const binding of [bindings.credentials, bindings.telegram]) {
        if (binding.state === "missing") continue;
        await useBoundCredentialRoot(binding, platform, () =>
          synchronizeDirectory(binding.root),
        );
      }
      const inventory = await scanCredentialEnvelopes(
        guardedCredentialEnvelopeRoots(roots, bindings),
      );
      await assertCredentialEnvelopeRootsStable(bindings);
      const deletionBlockers =
        inventory.deletionBlockers.length + inventory.unexplainedDeletionBlockers.length;
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
