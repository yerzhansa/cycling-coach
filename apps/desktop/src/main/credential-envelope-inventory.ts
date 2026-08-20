import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CREDENTIAL_FILE_MODE, DESKTOP_CREDENTIAL_SLOTS } from "./credential-vault.js";
import {
  SAFE_STORAGE_ENVELOPE_KEY_ID,
  readCredentialEnvelopeKeyId,
} from "./keychain-credential-encryption.js";
import {
  TELEGRAM_CREDENTIAL_FILE_MODE,
  TELEGRAM_PROFILE_FILE_NAME,
} from "./telegram-credential-vault.js";

export type CredentialEnvelopeVault = "credentials" | "telegram";

export interface CredentialEnvelopeTarget {
  readonly vault: CredentialEnvelopeVault;
  readonly root: string;
  readonly fileName: string;
  readonly mode: number;
}

export interface CredentialEnvelopeRef extends CredentialEnvelopeTarget {
  readonly keyId: number | undefined;
}

export interface CredentialEnvelopeInventory {
  readonly envelopes: readonly CredentialEnvelopeRef[];
  readonly legacy: readonly CredentialEnvelopeRef[];
  readonly migrated: number;
  readonly unreadable: number;
  readonly keychainRequired: boolean;
}

export interface CredentialEnvelopeRoots {
  readonly credentialRoot: string;
  readonly telegramRoot: string;
  readonly readEnvelopeFile?: typeof readFile;
  readonly classifyLegacyEnvelope?: (
    envelope: Buffer,
    target: CredentialEnvelopeTarget,
  ) => boolean | Promise<boolean>;
}

export function credentialEnvelopeTargets(
  roots: CredentialEnvelopeRoots,
): readonly CredentialEnvelopeTarget[] {
  return [
    ...DESKTOP_CREDENTIAL_SLOTS.map((slot) => ({
      vault: "credentials" as const,
      root: roots.credentialRoot,
      fileName: `${slot}.bin`,
      mode: CREDENTIAL_FILE_MODE,
    })),
    {
      vault: "telegram" as const,
      root: roots.telegramRoot,
      fileName: TELEGRAM_PROFILE_FILE_NAME,
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    },
  ];
}

export function credentialEnvelopeKeyId(envelope: Buffer): number {
  return readCredentialEnvelopeKeyId(envelope) ?? SAFE_STORAGE_ENVELOPE_KEY_ID;
}

export async function scanCredentialEnvelopes(
  roots: CredentialEnvelopeRoots,
): Promise<CredentialEnvelopeInventory> {
  const read = roots.readEnvelopeFile ?? readFile;
  const envelopes: CredentialEnvelopeRef[] = [];
  for (const target of credentialEnvelopeTargets(roots)) {
    let contents: Buffer | undefined;
    try {
      contents = await read(join(target.root, target.fileName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      envelopes.push({ ...target, keyId: undefined });
      continue;
    }
    try {
      let keyId = readCredentialEnvelopeKeyId(contents);
      if (keyId === undefined || keyId === SAFE_STORAGE_ENVELOPE_KEY_ID) {
        keyId = undefined;
        try {
          if (await roots.classifyLegacyEnvelope?.(contents, target)) {
            keyId = SAFE_STORAGE_ENVELOPE_KEY_ID;
          }
        } catch {}
      }
      envelopes.push({ ...target, keyId });
    } finally {
      contents.fill(0);
    }
  }
  const legacy = envelopes.filter((envelope) => envelope.keyId === SAFE_STORAGE_ENVELOPE_KEY_ID);
  const unreadable = envelopes.filter((envelope) => envelope.keyId === undefined).length;
  const migrated = envelopes.length - legacy.length - unreadable;
  return {
    envelopes,
    legacy,
    migrated,
    unreadable,
    keychainRequired: migrated > 0 || unreadable > 0,
  };
}
