# Desktop

The Electron desktop application. Hosts the coaching daemon, the renderer, and the credential storage the athlete configures during onboarding. This file is the shared vocabulary for that credential storage; it defines terms, not mechanisms.

## Language

**Vault**:
A store of encrypted credential records owned by the desktop app. Two exist: the per-slot LLM and intervals.icu store (`credentials-v1`) and the single-record Telegram profile store (`telegram-channel-v1`). A vault owns durability, refusal, and uncertainty; it never owns encryption.
_Avoid_: Keystore, secret store, credential manager

**Slot**:
One named credential position inside a vault — one AI provider or intervals.icu. A slot holds at most one credential and carries its own state (`missing`, `configured`, `re-prompt`) independently of every other slot.
_Avoid_: Key, entry, provider (a provider is the upstream service; a slot is where its credential lives)

**Envelope**:
The on-disk form of one credential: a self-describing byte blob that a vault writes and reads whole. An envelope declares which key protects it, so a directory holding envelopes from two eras is still readable rather than ambiguous.
_Avoid_: Blob, ciphertext, encrypted file

**Backend**:
The named implementation that turns a credential into an envelope and back. Each backend reports its own name, so a vault can recognise an unsafe one and refuse to write rather than store a credential the athlete believes is protected. `basic_text` is the name that means unprotected.
_Avoid_: Cipher, provider, encryptor

**Helper**:
A separate signed executable the desktop app runs to reach a platform facility Electron cannot reach itself. It answers one request and exits. A helper never receives or returns a credential value — only the key material a backend needs.
_Avoid_: Daemon, service, agent (the daemon is the long-lived coaching process; a helper is short-lived and answers one question)

**Key-id**:
The single number inside an envelope naming the key that protects it. `0` names the platform-secure-storage era. Any other value names a later key. Without a key-id an envelope from one era is indistinguishable from another, and a half-migrated vault cannot be repaired.
_Avoid_: Version, key version, generation

**Poisoned item**:
A stored key that exists but cannot be read by the app entitled to it. It is a recoverable state, not a fatal one: the app destroys it and creates a fresh key, accepting that every envelope under the old key must be re-entered. Distinct from a missing key, which is simply the first-run case.
_Avoid_: Corrupt key, broken keychain, orphaned item

## Relationships

- A **Vault** holds **Slot**s; each configured slot has exactly one **Envelope**.
- A **Vault** delegates every encryption and decryption to one **Backend** and never inspects an **Envelope** itself.
- A **Backend** may need a **Helper** to obtain its key; a backend that needs no helper has none.
- Every **Envelope** carries the **Key-id** of the key that sealed it.
- A **Poisoned item** is a **Backend** concern; a **Vault** only ever sees the refusal that follows.

## Example dialogue

> **Dev:** "The athlete removed their Telegram integration. Do we destroy the key too?"
> **Domain expert:** "No. One key seals every **Envelope** in both **Vault**s. Removing one integration deletes that **Slot**'s envelope and nothing else — destroying the key would take every remaining credential with it."

## Flagged ambiguities

- "Key" was used for both a credential the athlete pastes in (an API key) and the secret that encrypts it. Resolved: an athlete-supplied secret lives in a **Slot**; the secret that seals envelopes is the encryption key, named only as such.
