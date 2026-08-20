import {
  scanCredentialEnvelopes,
  type CredentialEnvelopeRoots,
} from "./credential-envelope-inventory.js";
import type { KeychainHelperErrorCode, KeychainHelperTransport } from "./keychain-helper.js";
import type { KeychainKeyRotation } from "./keychain-credential-encryption.js";

export type KeychainKeyRetirement =
  | Readonly<{ status: "retained"; envelopes: number }>
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "rotated" }>
  | Readonly<{ status: "already-absent" }>
  | Readonly<{ status: "failed"; code: KeychainHelperErrorCode }>;

export interface RetireKeychainKeyOptions extends CredentialEnvelopeRoots {
  readonly transport: KeychainHelperTransport;
  readonly service: string;
  readonly rotate?: () => Promise<KeychainKeyRotation>;
}

export async function retireKeychainKeyWhenLastEnvelopeGone(
  options: RetireKeychainKeyOptions,
): Promise<KeychainKeyRetirement> {
  const inventory = await scanCredentialEnvelopes(options);
  if (inventory.envelopes.length > 0) {
    return { status: "retained", envelopes: inventory.envelopes.length };
  }
  if (options.rotate !== undefined) {
    const rotated = await options.rotate();
    return rotated.status === "rotated"
      ? { status: "rotated" }
      : { status: "failed", code: rotated.code };
  }
  const deleted = await options.transport.send({ op: "delete-key", service: options.service });
  if (!deleted.ok) return { status: "failed", code: deleted.code };
  if (deleted.op !== "delete-key") return { status: "failed", code: "unknown" };
  return deleted.deleted ? { status: "deleted" } : { status: "already-absent" };
}
