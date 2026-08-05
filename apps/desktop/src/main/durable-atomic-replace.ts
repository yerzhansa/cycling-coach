import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";

export type DurableReplaceOutcome =
  | Readonly<{ state: "not-committed" }>
  | Readonly<{ state: "durably-committed" }>
  | Readonly<{ state: "commit-uncertain" }>;

export interface DurableAtomicReplaceInput {
  readonly root: string;
  readonly fileName: string;
  readonly contents: string | Buffer;
  readonly mode: number;
  readonly createId?: () => string;
  readonly openFile?: typeof open;
  readonly openDirectory?: typeof open;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
}

export type ReversibleDurableReplaceOutcome =
  | Readonly<{ state: "applied" }>
  | Readonly<{ state: "refused" }>
  | Readonly<{ state: "uncertain" }>;

export interface ReversibleDurableReplaceInput extends DurableAtomicReplaceInput {
  readonly previousContents: Buffer | undefined;
  readonly readCurrent?: (target: string) => Promise<Buffer | undefined>;
}

async function syncDirectory(root: string, openDirectory: typeof open): Promise<void> {
  const directory = await openDirectory(root, "r");
  try {
    await directory.sync();
  } catch (error) {
    await directory.close().catch(() => undefined);
    throw error;
  }
  await directory.close().catch(() => undefined);
}

export async function durableAtomicReplace(
  input: DurableAtomicReplaceInput,
): Promise<DurableReplaceOutcome> {
  if (
    input.root.length === 0 ||
    input.fileName.length === 0 ||
    basename(input.fileName) !== input.fileName
  ) {
    throw new TypeError("invalid durable replacement target");
  }
  const createId = input.createId ?? randomUUID;
  const id = createId();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new TypeError("invalid durable replacement temporary id");
  }
  const openFile = input.openFile ?? open;
  const renameFile = input.renameFile ?? rename;
  const removeFile = input.removeFile ?? rm;
  const sync =
    input.syncDirectory ??
    ((root: string): Promise<void> => syncDirectory(root, input.openDirectory ?? open));
  const target = join(input.root, input.fileName);
  const temporary = join(input.root, `.${input.fileName}.${id}.tmp`);
  const contents = Buffer.isBuffer(input.contents)
    ? Buffer.from(input.contents)
    : Buffer.from(input.contents, "utf8");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let renamed = false;
  try {
    handle = await openFile(temporary, "wx", input.mode);
    await handle.writeFile(contents);
    await handle.chmod(input.mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await renameFile(temporary, target);
    renamed = true;
    await sync(input.root);
    return { state: "durably-committed" };
  } catch {
    return { state: renamed ? "commit-uncertain" : "not-committed" };
  } finally {
    contents.fill(0);
    try {
      await handle?.close();
    } catch {}
    await removeFile(temporary, { force: true }).catch(() => undefined);
  }
}

interface DurableAtomicRemoveInput {
  readonly root: string;
  readonly fileName: string;
  readonly createId?: () => string;
  readonly openDirectory?: typeof open;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
}

async function durableAtomicRemove(
  input: DurableAtomicRemoveInput,
): Promise<DurableReplaceOutcome> {
  const createId = input.createId ?? randomUUID;
  const id = createId();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    throw new TypeError("invalid durable removal temporary id");
  }
  const renameFile = input.renameFile ?? rename;
  const removeFile = input.removeFile ?? rm;
  const sync =
    input.syncDirectory ??
    ((root: string): Promise<void> => syncDirectory(root, input.openDirectory ?? open));
  const target = join(input.root, input.fileName);
  const tombstone = join(input.root, `.${input.fileName}.${id}.deleted`);
  try {
    await renameFile(target, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { state: "not-committed" };
    }
  }
  try {
    await sync(input.root);
  } catch {
    return { state: "commit-uncertain" };
  }
  await removeFile(tombstone, { force: true }).catch(() => undefined);
  await sync(input.root).catch(() => undefined);
  return { state: "durably-committed" };
}

async function readVisibleFile(target: string): Promise<Buffer | undefined> {
  try {
    return await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function durablyReplaceReversible(
  input: ReversibleDurableReplaceInput,
): Promise<ReversibleDurableReplaceOutcome> {
  let operationId: string;
  try {
    operationId = (input.createId ?? randomUUID)();
  } catch {
    return { state: "refused" };
  }
  if (!/^[A-Za-z0-9-]{1,128}$/.test(operationId)) return { state: "refused" };
  const operationInput = { ...input, createId: () => operationId };
  const candidate = Buffer.isBuffer(input.contents)
    ? Buffer.from(input.contents)
    : Buffer.from(input.contents, "utf8");
  const previous =
    input.previousContents === undefined ? undefined : Buffer.from(input.previousContents);
  const replace = (contents: Buffer): Promise<DurableReplaceOutcome> =>
    durableAtomicReplace({ ...operationInput, contents });
  const restorePrevious = (): Promise<DurableReplaceOutcome> =>
    previous === undefined
      ? durableAtomicRemove(operationInput)
      : durableAtomicReplace({ ...operationInput, contents: previous });
  try {
    const initial = await replace(candidate);
    if (initial.state === "durably-committed") return { state: "applied" };
    if (initial.state === "not-committed") return { state: "refused" };

    let compensation: DurableReplaceOutcome;
    try {
      compensation = await restorePrevious();
    } catch {
      return { state: "uncertain" };
    }
    if (compensation.state === "durably-committed") return { state: "refused" };

    let current: Buffer | undefined;
    try {
      current = await (input.readCurrent ?? readVisibleFile)(join(input.root, input.fileName));
    } catch {
      return { state: "uncertain" };
    }
    try {
      const previousVisible =
        previous === undefined ? current === undefined : current?.equals(previous) === true;
      if (previousVisible) {
        let convergedPrevious: DurableReplaceOutcome;
        try {
          convergedPrevious = await restorePrevious();
        } catch {
          return { state: "uncertain" };
        }
        return convergedPrevious.state === "durably-committed"
          ? { state: "refused" }
          : { state: "uncertain" };
      }
      if (current?.equals(candidate) === true) {
        let convergedCandidate: DurableReplaceOutcome;
        try {
          convergedCandidate = await replace(candidate);
        } catch {
          return { state: "uncertain" };
        }
        return convergedCandidate.state === "durably-committed"
          ? { state: "applied" }
          : { state: "uncertain" };
      }
      return { state: "uncertain" };
    } finally {
      current?.fill(0);
    }
  } finally {
    candidate.fill(0);
    previous?.fill(0);
  }
}
