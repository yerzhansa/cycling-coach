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

**Deletion blocker**:
A canonical envelope or recognised transient credential artifact whose presence forbids automatic destruction or replacement of an existing encryption key. A deletion blocker does not necessarily prove that it needs that key.
_Avoid_: Dependent envelope, credential file

**Key-dependent envelope**:
An envelope positively identified as protected by the shared encryption key named by key-id `1`. Its credential cannot be decrypted without that exact key.
_Avoid_: Keychain envelope, dependent envelope

**Backend**:
The named implementation that turns a credential into an envelope and back. Each backend reports its own name, so a vault can recognise an unsafe one and refuse to write rather than store a credential the athlete believes is protected. `basic_text` is the name that means unprotected.
_Avoid_: Cipher, provider, encryptor

**Native binding**:
The macOS credential boundary loaded only by Desktop main. It authenticates the exact Enduragent host and has no separate caller-facing process. The stored Keychain item separately trusts same-user code signed by Team `FA494ACVTF`.
_Avoid_: Helper, sidecar, daemon, service

**Key-id**:
The single number inside an envelope naming the key that protects it. `0` claims the platform-secure-storage era. Any other value names a later key. A claim of `0` is not proof because damaged bytes can carry the same value.
_Avoid_: Version, key version, generation

**Unverified envelope**:
An envelope whose protecting backend cannot be proven without requesting user interaction. It is a deletion blocker but is not proven key-dependent.
_Avoid_: Legacy envelope, unreadable envelope, corrupt envelope

**Uninspectable item**:
An existing keychain item whose contents or access rules cannot be positively verified. This state does not prove corruption and never authorises destroying the encryption key.
_Avoid_: Poisoned item, corrupt key, broken keychain

**Unreadable item**:
An existing keychain item whose returned key material or required access marker fails validation. It is positively present but cannot supply a usable encryption key.
_Avoid_: Missing key, uninspectable item

**Missing encryption key**:
The absent shared encryption key. Key-dependent envelopes then require credential reset, while unverified envelopes remain candidates for explicit per-slot recovery.
_Avoid_: Unconfigured credential, empty vault

**Orphan encryption key**:
An existing encryption key for which neither vault contains a deletion blocker. It carries no remaining credential dependency.
_Avoid_: Unused key, stale key

**Credential recovery**:
The in-app process by which an athlete replaces an unverified envelope with a newly entered credential.
_Avoid_: Keychain recovery, password reset

**Credential reset**:
The explicit in-app process that removes every Enduragent-managed credential, every credential envelope, and the shared encryption key when recovery cannot succeed or is unwanted. It leaves Electron's old `safeStorage` support item untouched.
_Avoid_: Keychain reset, reset to defaults

**Recovery status**:
The current cross-vault account of encryption availability and slots that require credential recovery. It describes live credential state, not a startup snapshot.
_Avoid_: Recovery snapshot, startup status

## Windows release and updater

**Release marker**:
`enduragentDesktopRelease: true` in the packaged `package.json`; required by `isDesktopUpdateReleaseEligible`.
_Avoid_: Release flag, Windows marker

**Platform activation**:
`DESKTOP_UPDATE_PLATFORM_ACTIVATION` (`darwin: true`, `win32: false`); the only switch that turns Windows update checks on. `DESKTOP_UPDATE_SUPPORTED_PLATFORMS` lists the platforms the updater knows.
_Avoid_: Platform support, supported-platform switch

**Windows release envelope**:
The installer `.exe`, its `.blockmap`, and `latest.yml`; produced by `windows-release-plan.mjs`, verified by `verify-windows-release.mjs`, uploaded by `upload-windows-release.mjs`, and round-trip-checked by `verify-windows-updater-round-trip.mjs`.
_Avoid_: Windows bundle, release files

**Authenticode pending mode**:
`WINDOWS_AUTHENTICODE_PENDING` = `pending-w19`, a dry-run-only `--authenticode` value for `verify-windows-release.mjs`; `upload-windows-release.mjs` accepts only `verify`.
_Avoid_: Unsigned mode, signing bypass

**Windows release provenance**:
The `enduragent-release-commit:<sha>` string that `windows-release-plan.mjs` seals into the installer's `LegalTrademarks` version field; `verify-windows-authenticode.ps1` reads it back and `--commit` must match.
_Avoid_: Build stamp, commit marker

**Windows package inventory**:
The exact application, resource, and asar inventories checked by `verify-windows-package.mjs`.
_Avoid_: Package contents, file list

**Windows user data directory**:
`WINDOWS_USER_DATA_DIRECTORY_NAME` under `%LOCALAPPDATA%`; it resolves to `%LOCALAPPDATA%\Enduragent` and survives uninstall.
_Avoid_: Install directory, application directory

## Relationships

- A **Vault** holds **Slot**s; each configured slot has exactly one **Envelope**.
- A **Vault** delegates every encryption and decryption to one **Backend** and never inspects an **Envelope** itself.
- A **Backend** may use the **Native binding** to obtain its platform key. Renderer and unsigned external callers never belong to that boundary.
- Every **Envelope** carries the **Key-id** of the key that sealed it.
- Every canonical envelope and recognised transient credential artifact is a **Deletion blocker**.
- A **Key-dependent envelope** is a **Deletion blocker**. An **Unverified envelope** is a **Deletion blocker** but is not proven key-dependent.
- An **Unverified envelope** belongs to one **Slot**. Other slots remain usable while their backend and encryption key remain available.
- An **Uninspectable item** or **Unreadable item** prevents credential recovery and key replacement until the key becomes usable or the athlete chooses **Credential reset**.
- **Credential recovery** replaces one slot only after the newly entered credential is safely stored.
- **Credential reset** is the only recovery path when the encryption key is missing while a **Key-dependent envelope** survives.
- When the encryption key is missing and only unverified envelopes survive, **Credential recovery** may replace one slot while preserving every other artifact.
- An **Orphan encryption key** may be removed without losing a credential.
- **Recovery status** is derived from both vaults whenever it is requested.
- The **Release marker** admits a packaged build to `isDesktopUpdateReleaseEligible`; **Platform activation** independently decides whether update checks run on the current platform.
- A **Windows release envelope** is produced, verified, uploaded, and round-trip-checked by its named scripts.
- **Authenticode pending mode** does not authorise an unsigned installer for a GitHub release or the website.
- **Windows release provenance** binds a verified installer to the release tag commit before upload.
- The **Windows package inventory** fixes the application, resource, and asar contents accepted by package verification.
- The athlete removes the **Windows user data directory** by hand when retained data must be erased after uninstall.

## Example dialogue

> **Dev:** "The athlete removed their Telegram integration. Do we destroy the key too?"
> **Domain expert:** "No. One key seals every **Envelope** in both **Vault**s. Removing one integration deletes that **Slot**'s envelope and nothing else — destroying the key would take every remaining credential with it."

## Flagged ambiguities

- "Key" was used for both a credential the athlete pastes in (an API key) and the secret that encrypts it. Resolved: an athlete-supplied secret lives in a **Slot**; the secret that seals envelopes is the encryption key, named only as such.
