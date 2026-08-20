import {
  scanCredentialEnvelopes,
  type CredentialEnvelopeRoots,
} from "./credential-envelope-inventory.js";
import type { KeychainHelperErrorCode, KeychainHelperTransport } from "./keychain-helper.js";

export type KeychainKeyRetirement =
  | Readonly<{ status: "retained"; envelopes: number }>
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "already-absent" }>
  | Readonly<{ status: "failed"; code: KeychainHelperErrorCode }>;

export interface RetireKeychainKeyOptions extends CredentialEnvelopeRoots {
  readonly transport: KeychainHelperTransport;
  readonly service: string;
}

export async function retireKeychainKeyWhenLastEnvelopeGone(
  options: RetireKeychainKeyOptions,
): Promise<KeychainKeyRetirement> {
  const inventory = await scanCredentialEnvelopes(options);
  if (inventory.envelopes.length > 0) {
    return { status: "retained", envelopes: inventory.envelopes.length };
  }
  const deleted = await options.transport.send({ op: "delete-key", service: options.service });
  if (!deleted.ok) return { status: "failed", code: deleted.code };
  if (deleted.op !== "delete-key") return { status: "failed", code: "unknown" };
  return deleted.deleted ? { status: "deleted" } : { status: "already-absent" };
}
