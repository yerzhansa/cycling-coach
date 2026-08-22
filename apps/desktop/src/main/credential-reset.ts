import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
} from "./credential-envelope-lock.js";
import {
  credentialEnvelopeTargets,
  scanCredentialEnvelopes,
  type CredentialEnvelopeRoots,
} from "./credential-envelope-inventory.js";
import { syncDirectory } from "./durable-atomic-replace.js";
import type { KeychainKeyDeletion } from "./keychain-credential-encryption.js";

export type EncryptedCredentialResetResult =
  | Readonly<{ status: "reset"; keyCleanupPending: boolean }>
  | Readonly<{ status: "failed" }>;

export interface ResetEncryptedCredentialStorageOptions extends CredentialEnvelopeRoots {
  readonly serializeEnvelopeMutation: SerializeCredentialEnvelopeMutation;
  readonly deleteKey: (proof: CredentialEnvelopeLockProof) => Promise<KeychainKeyDeletion>;
  readonly removeFile?: typeof rm;
  readonly syncCredentialDirectory?: (root: string) => Promise<void>;
}

export function resetEncryptedCredentialStorage(
  options: ResetEncryptedCredentialStorageOptions,
): Promise<EncryptedCredentialResetResult> {
  return options.serializeEnvelopeMutation(async (proof) => {
    const removeFile = options.removeFile ?? rm;
    const syncCredentialDirectory = options.syncCredentialDirectory ?? syncDirectory;
    const roots = new Set<string>();
    try {
      for (const target of credentialEnvelopeTargets(options)) {
        roots.add(target.root);
        await removeFile(join(target.root, target.fileName), { force: true });
      }
      const remaining = await scanCredentialEnvelopes(options);
      for (const blocker of remaining.deletionBlockers) {
        roots.add(blocker.root);
        await removeFile(join(blocker.root, blocker.fileName), { force: true });
      }
      for (const root of roots) {
        try {
          await syncCredentialDirectory(root);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if ((await scanCredentialEnvelopes(options)).deletionBlockers.length !== 0) {
        return { status: "failed" };
      }
      const key = await options.deleteKey(proof);
      return { status: "reset", keyCleanupPending: key.status === "failed" };
    } catch {
      return { status: "failed" };
    }
  });
}
