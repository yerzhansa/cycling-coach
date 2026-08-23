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
import {
  assertCredentialEnvelopeRootsStable,
  bindCredentialEnvelopeRoots,
  credentialRootBindingForVault,
  guardedCredentialEnvelopeRoots,
  isMissingCredentialRootError,
  refreshCredentialEnvelopeRootBindings,
  useBoundCredentialRoot,
  useBoundCredentialRootMutation,
} from "./credential-envelope-root-binding.js";
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
  readonly platform?: NodeJS.Platform;
}

export function resetEncryptedCredentialStorage(
  options: ResetEncryptedCredentialStorageOptions,
): Promise<EncryptedCredentialResetResult> {
  return options.serializeEnvelopeMutation(async (proof) => {
    const removeFile = options.removeFile ?? rm;
    const syncCredentialDirectory = options.syncCredentialDirectory ?? syncDirectory;
    const platform = options.platform ?? process.platform;
    try {
      let bindings = await bindCredentialEnvelopeRoots(options, platform);
      for (const target of credentialEnvelopeTargets(options)) {
        const binding = credentialRootBindingForVault(bindings, target.vault);
        if (binding.state === "missing") continue;
        await useBoundCredentialRootMutation(binding, platform, () =>
          removeFile(join(target.root, target.fileName), { force: true }),
        );
      }
      bindings = await refreshCredentialEnvelopeRootBindings(bindings);
      let guardedRoots = guardedCredentialEnvelopeRoots(options, bindings);
      const remaining = await scanCredentialEnvelopes(guardedRoots);
      for (const blocker of remaining.deletionBlockers) {
        const binding = credentialRootBindingForVault(bindings, blocker.vault);
        if (binding.state === "missing") throw new TypeError("missing credential root was scanned");
        await useBoundCredentialRootMutation(binding, platform, () =>
          removeFile(join(blocker.root, blocker.fileName), { force: true }),
        );
      }
      bindings = await refreshCredentialEnvelopeRootBindings(bindings);
      guardedRoots = guardedCredentialEnvelopeRoots(options, bindings);
      for (const binding of [bindings.credentials, bindings.telegram]) {
        if (binding.state === "missing") continue;
        try {
          await useBoundCredentialRoot(binding, platform, () =>
            syncCredentialDirectory(binding.root),
          );
        } catch (error) {
          if (!isMissingCredentialRootError(error)) throw error;
        }
      }
      if ((await scanCredentialEnvelopes(guardedRoots)).deletionBlockers.length !== 0) {
        return { status: "failed" };
      }
      await assertCredentialEnvelopeRootsStable(bindings);
      const key = await options.deleteKey(proof);
      return { status: "reset", keyCleanupPending: key.status === "failed" };
    } catch {
      return { status: "failed" };
    }
  });
}
