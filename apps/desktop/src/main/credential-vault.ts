import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  parseOnboardingLlmSelection,
  type OnboardingLlmSelection,
  type OnboardingLlmSelectionResult,
} from "./llm-selection.js";

export const DESKTOP_CREDENTIAL_SLOTS = [
  "anthropic",
  "openrouter",
  "openai",
  "google",
  "deepseek",
  "qwen",
  "minimax",
  "kimi",
  "zai",
  "intervals-icu",
] as const;

export type DesktopCredentialSlot = (typeof DESKTOP_CREDENTIAL_SLOTS)[number];
export type CredentialState = "missing" | "configured" | "re-prompt";
export type CredentialRuntimeState = "active" | "stored-inactive" | "failed";
export type CredentialRuntimeStateMap = Map<DesktopCredentialSlot, CredentialRuntimeState>;

export interface CredentialSlotStatus {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly runtimeState: CredentialRuntimeState | null;
}

export type CredentialWriteResult =
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "configured";
      readonly runtimeReady: boolean;
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "refused";
      readonly reason:
        | "invalid-input"
        | "encryption-unavailable"
        | "unsafe-backend"
        | "storage-failed"
        | "runtime-unavailable";
    };

export type CredentialDeleteResult =
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "deleted";
      readonly cleanupPending: boolean;
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "refused";
      readonly reason:
        | "not-found"
        | "managed-by-environment"
        | "storage-failed"
        | "runtime-unavailable"
        | "runtime-state-diverged";
    };

export const CREDENTIAL_DIRECTORY_NAME = "credentials-v1" as const;
export const CREDENTIAL_DIRECTORY_MODE = 0o700;
export const CREDENTIAL_FILE_MODE = 0o600;
export const UNSAFE_STORAGE_BACKEND = "basic_text" as const;

export interface CredentialEncryptionPort {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?: () => string;
}

export interface CredentialVault {
  writeCredential(
    input: {
      readonly slot: DesktopCredentialSlot;
      readonly value: string;
      readonly selection?: OnboardingLlmSelection;
    },
    behavior?: {
      readonly activate?: boolean;
    },
  ): Promise<CredentialWriteResult>;
  applyLlmSelection(input: OnboardingLlmSelection): Promise<OnboardingLlmSelectionResult>;
  credentialStatuses(): Promise<readonly CredentialSlotStatus[]>;
  deleteCredential(slot: DesktopCredentialSlot): Promise<CredentialDeleteResult>;
  reapplyConfigured(): Promise<void>;
  retryFailed(): Promise<void>;
}

interface CredentialVaultOptions {
  readonly root: string;
  readonly encryption: CredentialEncryptionPort;
  readonly runtimeState?: CredentialRuntimeStateMap;
  readonly onRuntimeStateChange?: (slot: DesktopCredentialSlot) => void;
  readonly createRuntimePublicationGuard?: (slot: DesktopCredentialSlot) => () => boolean;
  readonly applyCredential: (
    slot: DesktopCredentialSlot,
    value: string,
    selection?: OnboardingLlmSelection,
  ) => Promise<void>;
  readonly reapplyCredential?: (
    slot: DesktopCredentialSlot,
    value: string,
    storedCredentialSlots: readonly DesktopCredentialSlot[],
  ) => Promise<Exclude<CredentialRuntimeState, "failed">>;
  readonly clearCredential?: (
    slot: DesktopCredentialSlot,
  ) => Promise<"cleared" | "not-active" | "managed-by-environment">;
  readonly renameCredentialFile?: typeof rename;
  readonly removeCredentialFile?: typeof rm;
  readonly syncCredentialDirectory?: (root: string) => Promise<void>;
}

export function replaceCredentialRuntimeStates(
  target: CredentialRuntimeStateMap,
  statuses: readonly CredentialSlotStatus[],
  shouldReplace: (slot: DesktopCredentialSlot) => boolean = () => true,
): void {
  for (const status of statuses) {
    if (!shouldReplace(status.slot)) {
      target.set(status.slot, "failed");
      continue;
    }
    if (status.state === "configured" && status.runtimeState !== null) {
      target.set(status.slot, status.runtimeState);
    } else {
      target.delete(status.slot);
    }
  }
}

export function markUnselectedModelCredentialsInactive(
  target: CredentialRuntimeStateMap,
  selected: DesktopCredentialSlot | undefined,
  onChange: (slot: DesktopCredentialSlot) => void = () => {},
): void {
  for (const slot of target.keys()) {
    if (slot === "intervals-icu" || slot === selected || target.get(slot) === "stored-inactive") {
      continue;
    }
    target.set(slot, "stored-inactive");
    onChange(slot);
  }
}

interface ReadCredential {
  readonly slot: DesktopCredentialSlot;
  readonly state: CredentialState;
  readonly value?: string;
  readonly modifiedAt: number;
}

function isCredentialSlot(value: unknown): value is DesktopCredentialSlot {
  return (
    typeof value === "string" && (DESKTOP_CREDENTIAL_SLOTS as readonly string[]).includes(value)
  );
}

function permissions(mode: number): number {
  return mode & 0o777;
}

async function secureDirectory(root: string): Promise<boolean> {
  try {
    await mkdir(root, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
    const entry = await lstat(root);
    return (
      entry.isDirectory() &&
      !entry.isSymbolicLink() &&
      permissions(entry.mode) === CREDENTIAL_DIRECTORY_MODE
    );
  } catch {
    return false;
  }
}

async function validTarget(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    return (
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.size > 0 &&
      permissions(entry.mode) === CREDENTIAL_FILE_MODE
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

export function createCredentialVault(options: CredentialVaultOptions): CredentialVault {
  const runtimeState =
    options.runtimeState ?? new Map<DesktopCredentialSlot, CredentialRuntimeState>();
  const setRuntimeState = (slot: DesktopCredentialSlot, state: CredentialRuntimeState): void => {
    if (state === "active" && slot !== "intervals-icu") {
      markUnselectedModelCredentialsInactive(runtimeState, slot, options.onRuntimeStateChange);
    }
    runtimeState.set(slot, state);
    options.onRuntimeStateChange?.(slot);
  };
  const clearRuntimeState = (slot: DesktopCredentialSlot): void => {
    runtimeState.delete(slot);
    options.onRuntimeStateChange?.(slot);
  };
  const syncCredentialDirectory =
    options.syncCredentialDirectory ??
    (async (root: string): Promise<void> => {
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
  const renameCredentialFile = options.renameCredentialFile ?? rename;
  const removeCredentialFile = options.removeCredentialFile ?? rm;

  const removeStoredCredential = async (
    slot: DesktopCredentialSlot,
  ): Promise<"deleted" | "cleanup-pending" | "retained" | "uncertain"> => {
    const target = join(options.root, `${slot}.bin`);
    const tombstone = join(options.root, `.${slot}.${randomUUID()}.deleted`);
    try {
      await renameCredentialFile(target, tombstone);
    } catch {
      return "retained";
    }
    try {
      await syncCredentialDirectory(options.root);
    } catch {
      try {
        await renameCredentialFile(tombstone, target);
        await syncCredentialDirectory(options.root);
        return "retained";
      } catch {
        return "uncertain";
      }
    }
    try {
      await removeCredentialFile(tombstone, { force: true });
      await syncCredentialDirectory(options.root);
      return "deleted";
    } catch {
      return "cleanup-pending";
    }
  };
  const cleanupDeletedCredentials = async (): Promise<void> => {
    let cleaned = false;
    let entries: readonly string[];
    try {
      entries = await readdir(options.root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        !DESKTOP_CREDENTIAL_SLOTS.some(
          (slot) => entry.startsWith(`.${slot}.`) && entry.endsWith(".deleted"),
        )
      ) {
        continue;
      }
      try {
        await removeCredentialFile(join(options.root, entry), { force: true });
        cleaned = true;
      } catch {}
    }
    if (cleaned) await syncCredentialDirectory(options.root).catch(() => undefined);
  };

  const readSlot = async (slot: DesktopCredentialSlot): Promise<ReadCredential> => {
    const path = join(options.root, `${slot}.bin`);
    let encrypted: Buffer | undefined;
    try {
      const directory = await lstat(options.root);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        permissions(directory.mode) !== CREDENTIAL_DIRECTORY_MODE
      ) {
        return { slot, state: "re-prompt", modifiedAt: 0 };
      }
      const entry = await lstat(path);
      if (
        !entry.isFile() ||
        entry.isSymbolicLink() ||
        entry.size === 0 ||
        permissions(entry.mode) !== CREDENTIAL_FILE_MODE
      ) {
        return { slot, state: "re-prompt", modifiedAt: entry.mtimeMs };
      }
      encrypted = await readFile(path);
      const value = options.encryption.decryptString(encrypted).trim();
      if (value.length === 0) return { slot, state: "re-prompt", modifiedAt: entry.mtimeMs };
      return { slot, state: "configured", value, modifiedAt: entry.mtimeMs };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { slot, state: "missing", modifiedAt: 0 };
      }
      return { slot, state: "re-prompt", modifiedAt: 0 };
    } finally {
      encrypted?.fill(0);
    }
  };

  const readAll = async (): Promise<readonly ReadCredential[]> => {
    await cleanupDeletedCredentials();
    const entries: ReadCredential[] = [];
    for (const slot of DESKTOP_CREDENTIAL_SLOTS) entries.push(await readSlot(slot));
    return entries;
  };

  const reapplyConfigured = async (): Promise<void> => {
    const entries = (await readAll())
      .filter(
        (entry): entry is ReadCredential & { readonly value: string } =>
          entry.state === "configured" && entry.value !== undefined,
      )
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    const storedCredentialSlots = entries.map((entry) => entry.slot);
    for (const entry of entries) {
      try {
        const canPublish = options.createRuntimePublicationGuard?.(entry.slot);
        const replayed =
          options.reapplyCredential === undefined
            ? await options.applyCredential(entry.slot, entry.value).then(() => "active" as const)
            : await options.reapplyCredential(entry.slot, entry.value, storedCredentialSlots);
        if (canPublish !== undefined && !canPublish()) throw new TypeError();
        setRuntimeState(entry.slot, replayed);
      } catch {
        setRuntimeState(entry.slot, "failed");
      }
    }
  };

  const retryFailed = async (): Promise<void> => {
    const configured = (await readAll())
      .filter(
        (entry): entry is ReadCredential & { readonly value: string } =>
          entry.state === "configured" && entry.value !== undefined,
      )
      .sort((left, right) => left.modifiedAt - right.modifiedAt);
    const storedCredentialSlots = configured.map((entry) => entry.slot);
    const entries = configured.filter((entry) => runtimeState.get(entry.slot) === "failed");
    for (const entry of entries) {
      try {
        const canPublish = options.createRuntimePublicationGuard?.(entry.slot);
        const retried =
          options.reapplyCredential === undefined
            ? await options.applyCredential(entry.slot, entry.value).then(() => "active" as const)
            : await options.reapplyCredential(entry.slot, entry.value, storedCredentialSlots);
        if (canPublish !== undefined && !canPublish()) throw new TypeError();
        setRuntimeState(entry.slot, retried);
      } catch {
        setRuntimeState(entry.slot, "failed");
      }
    }
  };

  return {
    async writeCredential(input, behavior): Promise<CredentialWriteResult> {
      if (!isCredentialSlot(input?.slot) || typeof input.value !== "string") {
        return {
          slot: isCredentialSlot(input?.slot) ? input.slot : "anthropic",
          status: "refused",
          reason: "invalid-input",
        };
      }
      let selection: OnboardingLlmSelection | undefined;
      try {
        if (input.selection !== undefined) {
          selection = parseOnboardingLlmSelection(input.selection);
          if (input.slot === "intervals-icu" || selection.provider !== input.slot) {
            throw new TypeError();
          }
        }
      } catch {
        return { slot: input.slot, status: "refused", reason: "invalid-input" };
      }
      const value = input.value.trim();
      if (value.length === 0) {
        return { slot: input.slot, status: "refused", reason: "invalid-input" };
      }
      try {
        if (!options.encryption.isEncryptionAvailable()) {
          return { slot: input.slot, status: "refused", reason: "encryption-unavailable" };
        }
        if (options.encryption.getSelectedStorageBackend?.() === UNSAFE_STORAGE_BACKEND) {
          return { slot: input.slot, status: "refused", reason: "unsafe-backend" };
        }
      } catch {
        return { slot: input.slot, status: "refused", reason: "encryption-unavailable" };
      }
      if (!(await secureDirectory(options.root))) {
        return { slot: input.slot, status: "refused", reason: "storage-failed" };
      }
      const target = join(options.root, `${input.slot}.bin`);
      if (!(await validTarget(target))) {
        return { slot: input.slot, status: "refused", reason: "storage-failed" };
      }
      const temporary = join(options.root, `.${input.slot}.${randomUUID()}.tmp`);
      let encrypted: Buffer | undefined;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        encrypted = options.encryption.encryptString(value);
        if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new TypeError();
        handle = await open(temporary, "wx", CREDENTIAL_FILE_MODE);
        await handle.writeFile(encrypted);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, target);
        setRuntimeState(input.slot, "failed");
        const directory = await open(options.root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        try {
          await handle?.close();
        } catch {}
        await rm(temporary, { force: true }).catch(() => undefined);
        encrypted?.fill(0);
        return { slot: input.slot, status: "refused", reason: "storage-failed" };
      } finally {
        encrypted?.fill(0);
      }
      if (behavior?.activate === false) {
        setRuntimeState(input.slot, "stored-inactive");
        return { slot: input.slot, status: "configured", runtimeReady: false };
      }
      try {
        const canPublish = options.createRuntimePublicationGuard?.(input.slot);
        if (selection === undefined) {
          await options.applyCredential(input.slot, value);
        } else {
          await options.applyCredential(input.slot, value, selection);
        }
        if (canPublish !== undefined && !canPublish()) throw new TypeError();
        setRuntimeState(input.slot, "active");
        return { slot: input.slot, status: "configured", runtimeReady: true };
      } catch {
        setRuntimeState(input.slot, "failed");
        return { slot: input.slot, status: "refused", reason: "runtime-unavailable" };
      }
    },

    async applyLlmSelection(input): Promise<OnboardingLlmSelectionResult> {
      let selection: OnboardingLlmSelection;
      let slot: DesktopCredentialSlot;
      try {
        selection = parseOnboardingLlmSelection(input);
        if (selection.provider === "openai-codex") throw new TypeError();
        slot = selection.provider;
      } catch {
        return { status: "refused", reason: "invalid-input" };
      }
      const credential = await readSlot(slot);
      if (credential.state !== "configured" || credential.value === undefined) {
        return { status: "refused", reason: "credential-required" };
      }
      try {
        const canPublish = options.createRuntimePublicationGuard?.(slot);
        await options.applyCredential(slot, credential.value, selection);
        if (canPublish !== undefined && !canPublish()) throw new TypeError();
        setRuntimeState(slot, "active");
        return { status: "configured", runtimeReady: true };
      } catch {
        setRuntimeState(slot, "failed");
        return { status: "refused", reason: "runtime-unavailable" };
      }
    },

    async credentialStatuses(): Promise<readonly CredentialSlotStatus[]> {
      const entries = await readAll();
      return entries.map((entry) => ({
        slot: entry.slot,
        state: entry.state,
        runtimeState:
          entry.state === "configured" ? (runtimeState.get(entry.slot) ?? "stored-inactive") : null,
      }));
    },

    async deleteCredential(slot): Promise<CredentialDeleteResult> {
      if (!isCredentialSlot(slot)) {
        return { slot: "anthropic", status: "refused", reason: "not-found" };
      }
      const credential = await readSlot(slot);
      if (credential.state === "missing") {
        return { slot, status: "refused", reason: "not-found" };
      }
      const runtimeStatus = runtimeState.get(slot);
      const shouldClearRuntime = runtimeStatus === "active" || runtimeStatus === "failed";
      let runtimeCleared = false;
      if (shouldClearRuntime) {
        if (options.clearCredential === undefined) {
          return { slot, status: "refused", reason: "runtime-unavailable" };
        }
        try {
          const cleared = await options.clearCredential(slot);
          if (cleared === "managed-by-environment") {
            return { slot, status: "refused", reason: "managed-by-environment" };
          }
          if (cleared !== "cleared" && cleared !== "not-active") throw new TypeError();
          runtimeCleared = cleared === "cleared";
        } catch {
          setRuntimeState(slot, "failed");
          return { slot, status: "refused", reason: "runtime-state-diverged" };
        }
      }
      const removed = await removeStoredCredential(slot);
      if (removed === "deleted" || removed === "cleanup-pending") {
        clearRuntimeState(slot);
        return {
          slot,
          status: "deleted",
          cleanupPending: removed === "cleanup-pending",
        };
      }
      if (runtimeCleared && credential.value !== undefined && removed === "retained") {
        try {
          await options.applyCredential(slot, credential.value);
          setRuntimeState(slot, "active");
          return { slot, status: "refused", reason: "storage-failed" };
        } catch {
          setRuntimeState(slot, "failed");
          return { slot, status: "refused", reason: "runtime-state-diverged" };
        }
      }
      if (runtimeCleared) {
        setRuntimeState(slot, "failed");
        return { slot, status: "refused", reason: "runtime-state-diverged" };
      }
      return { slot, status: "refused", reason: "storage-failed" };
    },

    reapplyConfigured,
    retryFailed,
  };
}
