export interface Pbkdf2Params {
  readonly passphrase: Uint8Array;
  readonly salt: Uint8Array;
  readonly iterations: number;
  readonly hash: "SHA-256";
  readonly keyLengthBytes: number;
}

export interface AesGcmEncryptParams {
  readonly key: Uint8Array;
  readonly nonce: Uint8Array;
  readonly plaintext: Uint8Array;
  readonly additionalData?: Uint8Array;
}

export interface AesGcmDecryptParams {
  readonly key: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly additionalData?: Uint8Array;
}

export interface CryptoPort {
  /** 32-byte SHA-256 digest of the raw bytes. Hex-encoding is a pure kernel util, not part of this port. */
  sha256(data: Uint8Array): Promise<Uint8Array>;
  randomBytes(length: number): Promise<Uint8Array>;
  pbkdf2(params: Pbkdf2Params): Promise<Uint8Array>;
  /** AES-256-GCM. Returns the ciphertext with the 16-byte GCM auth tag appended (WebCrypto layout). */
  aesGcmEncrypt(params: AesGcmEncryptParams): Promise<Uint8Array>;
  /** AES-256-GCM. `ciphertext` carries the appended auth tag; rejects on tag-verification failure. */
  aesGcmDecrypt(params: AesGcmDecryptParams): Promise<Uint8Array>;
}
