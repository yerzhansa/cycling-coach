export const CREDENTIAL_ENVELOPE_MAGIC = "ENDURAGENT1" as const;
export const SAFE_STORAGE_ENVELOPE_KEY_ID = 0;
export const KEYCHAIN_ENVELOPE_KEY_ID = 1;
export const CREDENTIAL_ENVELOPE_IV_BYTES = 12;
export const CREDENTIAL_ENVELOPE_TAG_BYTES = 16;

const MAGIC = Buffer.from(CREDENTIAL_ENVELOPE_MAGIC, "ascii");
export const CREDENTIAL_ENVELOPE_HEADER_BYTES = MAGIC.length + 1;
export const CREDENTIAL_ENVELOPE_INSPECTION_BYTES =
  CREDENTIAL_ENVELOPE_HEADER_BYTES + CREDENTIAL_ENVELOPE_IV_BYTES + CREDENTIAL_ENVELOPE_TAG_BYTES;

export function readCredentialEnvelopeKeyId(envelope: Buffer): number | undefined {
  if (envelope.length < CREDENTIAL_ENVELOPE_INSPECTION_BYTES) return undefined;
  if (!envelope.subarray(0, MAGIC.length).equals(MAGIC)) return undefined;
  return envelope[MAGIC.length];
}
