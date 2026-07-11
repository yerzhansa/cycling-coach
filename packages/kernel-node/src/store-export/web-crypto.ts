import type { ExportCryptoPort, TextCodec } from "@enduragent/kernel/store/export";
import { PBKDF2_HASH, AES_KEY_BITS } from "@enduragent/kernel/store/export";

export const webCryptoTextCodec: TextCodec = {
  encodeUtf8: (s) => new TextEncoder().encode(s),
  decodeUtf8: (b) => new TextDecoder().decode(b),
};

function toBufferSource(view: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength &&
    view.buffer instanceof ArrayBuffer
  ) {
    return view as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(view.length);
  copy.set(view);
  return copy;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: "encrypt" | "decrypt",
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: toBufferSource(salt), iterations, hash: PBKDF2_HASH },
    base,
    { name: "AES-GCM", length: AES_KEY_BITS },
    false,
    [usage],
  );
}

export const webCryptoExportCrypto: ExportCryptoPort = {
  randomBytes(n) {
    const b = new Uint8Array(n);
    globalThis.crypto.getRandomValues(b);
    return b;
  },
  async encrypt({ passphrase, salt, iterations, nonce, aad, plaintext }) {
    const key = await deriveKey(passphrase, salt, iterations, "encrypt");
    const out = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toBufferSource(nonce), additionalData: toBufferSource(aad) },
      key,
      toBufferSource(plaintext),
    );
    return new Uint8Array(out);
  },
  async decrypt({ passphrase, salt, iterations, nonce, aad, ciphertext }) {
    const key = await deriveKey(passphrase, salt, iterations, "decrypt");
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBufferSource(nonce), additionalData: toBufferSource(aad) },
      key,
      toBufferSource(ciphertext),
    );
    return new Uint8Array(out);
  },
};

export const webCryptoExportEnv = { crypto: webCryptoExportCrypto, codec: webCryptoTextCodec } as const;
