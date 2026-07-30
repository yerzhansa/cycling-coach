import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import type {
  ConversationResetInput,
  TranscriptCompletedTurnInput,
  TranscriptConversationBoundaryReason,
  TranscriptWriterPort,
} from "@enduragent/engine";

const TRANSCRIPT_SCHEMA_VERSION = 1 as const;
const RESET_INTENT_SCHEMA_VERSION = 1 as const;
export const MAX_TRANSCRIPT_RECORD_BYTES = 262_144;
export const MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES = MAX_TRANSCRIPT_RECORD_BYTES + 4_096;
export const MAX_TRANSCRIPT_PAGE_TURNS = 50;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const RESET_ID_PATTERN = /^[a-f0-9]{64}$/;
const INTENT_TARGET_PATTERN = /^([a-f0-9]{64})\.reset-intent\.json$/;
const INTENT_TEMP_PATTERN = /^([a-f0-9]{64})\.([a-f0-9]{64})\.reset-intent\.tmp$/;
const TRANSCRIPT_CURSOR_BYTES = 114;
const TRANSCRIPT_CURSOR_LENGTH = 152;
const TRANSCRIPT_CURSOR_PATTERN = /^[A-Za-z0-9_-]{152}$/;
const TRANSCRIPT_CURSOR_VERSION = 1;
const ARCHIVED_TRANSCRIPT_CURSOR_VERSION = 2;
export const MAX_ARCHIVED_CONVERSATION_ENTRIES = 200;

type TranscriptWrite = (
  descriptor: number,
  buffer: NodeJS.ArrayBufferView,
  offset: number,
  length: number,
  position: number | null,
) => number;

interface TranscriptStoreHooks {
  readonly write?: TranscriptWrite;
  readonly syncFile?: (descriptor: number) => void;
  readonly syncDirectory?: (descriptor: number) => void;
  readonly beforeExistingFileOpen?: (path: string) => void;
  readonly afterChildOpen?: (path: string, descriptor: number) => void;
}

interface FileIdentity {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
}

class IncompleteTranscriptWriteError extends Error {
  constructor(readonly bytesWritten: number) {
    super("Transcript append was incomplete.");
    this.name = "IncompleteTranscriptWriteError";
  }
}

export class TranscriptBoundaryTargetUnchangedError extends Error {
  constructor(readonly originalError: unknown) {
    super("Conversation boundary append left the transcript target unchanged.", {
      cause: originalError,
    });
    this.name = "TranscriptBoundaryTargetUnchangedError";
  }
}

export interface TranscriptCompletedTurnRecord extends TranscriptCompletedTurnInput {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "turn-completed";
}

export interface TranscriptConversationBoundaryRecord extends ConversationResetInput {
  readonly version: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly kind: "conversation-boundary";
  readonly resetId: string;
}

export interface ResetIntentRecord extends ConversationResetInput {
  readonly version: typeof RESET_INTENT_SCHEMA_VERSION;
  readonly kind: "conversation-reset-intent";
  readonly resetId: string;
}

export type TranscriptRecord = TranscriptCompletedTurnRecord | TranscriptConversationBoundaryRecord;

export interface TranscriptPageTurn {
  readonly turnId: string;
  readonly completedAt: string;
  readonly athleteText: string;
  readonly coachText: string;
}

export interface TranscriptPageRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export type TranscriptPageResult =
  | {
      readonly schemaVersion: 1;
      readonly status: "page";
      readonly turns: TranscriptPageTurn[];
      readonly nextCursor: string | null;
    }
  | {
      readonly schemaVersion: 1;
      readonly status: "restart-required";
      readonly turns: [];
      readonly nextCursor: null;
    };

export interface ArchivedConversationSummary {
  readonly boundaryRef: string;
  readonly boundaryAt: string;
  readonly reason: TranscriptConversationBoundaryReason;
  readonly turnCount: number;
}

export interface ArchivedConversationList {
  readonly schemaVersion: 1;
  readonly conversations: ArchivedConversationSummary[];
  readonly truncated: boolean;
}

interface IndexedTranscriptTurn {
  readonly record: TranscriptCompletedTurnRecord;
  readonly start: number;
  readonly end: number;
}

interface CurrentTranscriptWindow {
  readonly trusted: boolean;
  readonly fenceKind: 0 | 1;
  readonly fence: Buffer;
  readonly turns: readonly IndexedTranscriptTurn[];
}

interface ArchivedTranscriptSegment {
  readonly boundary: TranscriptConversationBoundaryRecord;
  readonly boundaryEnd: number;
  readonly turns: readonly IndexedTranscriptTurn[];
}

interface DecodedTranscriptCursor {
  readonly fenceKind: 0 | 1;
  readonly chatDigest: Buffer;
  readonly fence: Buffer;
  readonly snapshotHash: Buffer;
  readonly snapshotEnd: number;
  readonly before: number;
}

export class UnsafeTranscriptTargetError extends Error {
  readonly code = "TRANSCRIPT_UNSAFE_TARGET";

  constructor() {
    super("Transcript storage target is unsafe.");
    this.name = "UnsafeTranscriptTargetError";
  }
}

export class TranscriptRecordTooLargeError extends Error {
  readonly code = "TRANSCRIPT_RECORD_TOO_LARGE";

  constructor() {
    super("Transcript record exceeds the maximum encoded size.");
    this.name = "TranscriptRecordTooLargeError";
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function identity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function isStrictPrivateFile(stats: Stats, allowedLinks: 1 | 2 = 1): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isFile() &&
    (stats.mode & 0o7777) === 0o600 &&
    stats.nlink === allowedLinks
  );
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | null {
  let text: string;
  try {
    text = STRICT_UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function parseRecordBytes(bytes: Buffer): TranscriptRecord | null {
  if (bytes.length + 1 > MAX_TRANSCRIPT_RECORD_BYTES) return null;
  const value = parseJsonObject(bytes);
  if (value === null || value.version !== TRANSCRIPT_SCHEMA_VERSION) return null;

  if (value.kind === "turn-completed") {
    if (
      !hasExactKeys(value, [
        "version",
        "kind",
        "chatId",
        "turnId",
        "completedAt",
        "athleteText",
        "coachText",
      ]) ||
      typeof value.chatId !== "string" ||
      typeof value.turnId !== "string" ||
      value.turnId.length === 0 ||
      typeof value.completedAt !== "string" ||
      !isIsoTimestamp(value.completedAt) ||
      typeof value.athleteText !== "string" ||
      typeof value.coachText !== "string"
    ) {
      return null;
    }
    return value as unknown as TranscriptCompletedTurnRecord;
  }

  if (value.kind === "conversation-boundary") {
    if (
      !hasExactKeys(value, ["version", "kind", "resetId", "chatId", "boundaryAt", "reason"]) ||
      typeof value.resetId !== "string" ||
      !RESET_ID_PATTERN.test(value.resetId) ||
      typeof value.chatId !== "string" ||
      typeof value.boundaryAt !== "string" ||
      !isIsoTimestamp(value.boundaryAt) ||
      (value.reason !== "explicit-reset" && value.reason !== "stale-reset")
    ) {
      return null;
    }
    return value as unknown as TranscriptConversationBoundaryRecord;
  }

  return null;
}

function completedTurnRecord(input: TranscriptCompletedTurnInput): TranscriptCompletedTurnRecord {
  if (
    typeof input.chatId !== "string" ||
    typeof input.turnId !== "string" ||
    input.turnId.length === 0 ||
    typeof input.completedAt !== "string" ||
    !isIsoTimestamp(input.completedAt) ||
    typeof input.athleteText !== "string" ||
    typeof input.coachText !== "string"
  ) {
    throw new TypeError("Completed transcript turn is invalid.");
  }
  return {
    version: TRANSCRIPT_SCHEMA_VERSION,
    kind: "turn-completed",
    chatId: input.chatId,
    turnId: input.turnId,
    completedAt: input.completedAt,
    athleteText: input.athleteText,
    coachText: input.coachText,
  };
}

function validateResetFields(input: {
  readonly resetId: string;
  readonly chatId: string;
  readonly boundaryAt: string;
  readonly reason: TranscriptConversationBoundaryReason;
}): void {
  if (
    typeof input.resetId !== "string" ||
    !RESET_ID_PATTERN.test(input.resetId) ||
    typeof input.chatId !== "string" ||
    typeof input.boundaryAt !== "string" ||
    !isIsoTimestamp(input.boundaryAt) ||
    (input.reason !== "explicit-reset" && input.reason !== "stale-reset")
  ) {
    throw new TypeError("Conversation reset record is invalid.");
  }
}

function conversationBoundaryRecord(
  input: ResetIntentRecord,
): TranscriptConversationBoundaryRecord {
  validateResetFields(input);
  return {
    version: TRANSCRIPT_SCHEMA_VERSION,
    kind: "conversation-boundary",
    resetId: input.resetId,
    chatId: input.chatId,
    boundaryAt: input.boundaryAt,
    reason: input.reason,
  };
}

function resetIntentRecord(input: {
  readonly resetId: string;
  readonly chatId: string;
  readonly boundaryAt: string;
  readonly reason: TranscriptConversationBoundaryReason;
}): ResetIntentRecord {
  validateResetFields(input);
  return {
    version: RESET_INTENT_SCHEMA_VERSION,
    kind: "conversation-reset-intent",
    resetId: input.resetId,
    chatId: input.chatId,
    boundaryAt: input.boundaryAt,
    reason: input.reason,
  };
}

function parseResetIntent(bytes: Buffer): ResetIntentRecord | null {
  if (bytes.length === 0 || bytes[bytes.length - 1] !== 0x0a) return null;
  const value = parseJsonObject(bytes.subarray(0, bytes.length - 1));
  if (
    value === null ||
    !hasExactKeys(value, ["version", "kind", "resetId", "chatId", "boundaryAt", "reason"]) ||
    value.version !== RESET_INTENT_SCHEMA_VERSION ||
    value.kind !== "conversation-reset-intent" ||
    typeof value.resetId !== "string" ||
    typeof value.chatId !== "string" ||
    typeof value.boundaryAt !== "string" ||
    (value.reason !== "explicit-reset" && value.reason !== "stale-reset")
  ) {
    return null;
  }
  try {
    return resetIntentRecord({
      resetId: value.resetId,
      chatId: value.chatId,
      boundaryAt: value.boundaryAt,
      reason: value.reason,
    });
  } catch {
    return null;
  }
}

function serializeTranscriptRecord(record: TranscriptRecord): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.length > MAX_TRANSCRIPT_RECORD_BYTES) {
    throw new TranscriptRecordTooLargeError();
  }
  return bytes;
}

function parseCurrentWindow(contents: Buffer, chatId: string): CurrentTranscriptWindow {
  let trusted = true;
  let fenceKind: 0 | 1 = 0;
  let fence = Buffer.alloc(32);
  let turns: IndexedTranscriptTurn[] = [];
  let lineStart = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== 0x0a) continue;
    const lineBytes = contents.subarray(lineStart, index);
    const recordStart = lineStart;
    lineStart = index + 1;
    const record = lineBytes.length === 0 ? null : parseRecordBytes(lineBytes);
    if (record === null || record.chatId !== chatId) {
      trusted = false;
      turns = [];
      continue;
    }
    if (record.kind === "conversation-boundary") {
      trusted = true;
      fenceKind = 1;
      fence = Buffer.from(record.resetId, "hex");
      turns = [];
    } else if (trusted) {
      turns.push({ record, start: recordStart, end: lineStart });
    }
  }
  if (lineStart !== contents.length) {
    trusted = false;
    turns = [];
  }
  return { trusted, fenceKind, fence, turns };
}

function parseArchivedSegments(contents: Buffer, chatId: string): ArchivedTranscriptSegment[] {
  const segments: ArchivedTranscriptSegment[] = [];
  let trusted = true;
  let turns: IndexedTranscriptTurn[] = [];
  let lineStart = 0;
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] !== 0x0a) continue;
    const lineBytes = contents.subarray(lineStart, index);
    const recordStart = lineStart;
    lineStart = index + 1;
    const record = lineBytes.length === 0 ? null : parseRecordBytes(lineBytes);
    if (record === null || record.chatId !== chatId) {
      trusted = false;
      turns = [];
      continue;
    }
    if (record.kind === "conversation-boundary") {
      segments.push({ boundary: record, boundaryEnd: lineStart, turns });
      trusted = true;
      turns = [];
    } else if (trusted) {
      turns.push({ record, start: recordStart, end: lineStart });
    }
  }
  return segments;
}

function selectArchivedSegment(
  segments: readonly ArchivedTranscriptSegment[],
  boundaryRef: string,
): ArchivedTranscriptSegment | null {
  const matches = segments.filter((segment) => segment.boundary.resetId === boundaryRef);
  if (matches.length > 1) throw new Error("Transcript contains duplicate reset boundaries.");
  return matches[0] ?? null;
}

function decodeSafeOffset(bytes: Buffer, offset: number): number | null {
  const value = bytes.readBigUInt64BE(offset);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function decodeCursorVersion(value: string, version: number): DecodedTranscriptCursor | null {
  if (!TRANSCRIPT_CURSOR_PATTERN.test(value) || value.length !== TRANSCRIPT_CURSOR_LENGTH) {
    return null;
  }
  const bytes = Buffer.from(value, "base64url");
  if (
    bytes.length !== TRANSCRIPT_CURSOR_BYTES ||
    bytes.toString("base64url") !== value ||
    bytes[0] !== version ||
    (bytes[1] !== 0 && bytes[1] !== 1)
  ) {
    return null;
  }
  const fenceKind = bytes[1] as 0 | 1;
  const fence = Buffer.from(bytes.subarray(34, 66));
  if (fenceKind === 0 && fence.some((byte) => byte !== 0)) return null;
  const snapshotEnd = decodeSafeOffset(bytes, 98);
  const before = decodeSafeOffset(bytes, 106);
  if (snapshotEnd === null || before === null || before > snapshotEnd) return null;
  return {
    fenceKind,
    chatDigest: Buffer.from(bytes.subarray(2, 34)),
    fence,
    snapshotHash: Buffer.from(bytes.subarray(66, 98)),
    snapshotEnd,
    before,
  };
}

function decodeTranscriptCursor(value: string): DecodedTranscriptCursor | null {
  return decodeCursorVersion(value, TRANSCRIPT_CURSOR_VERSION);
}

function decodeArchivedTranscriptCursor(value: string): DecodedTranscriptCursor | null {
  const decoded = decodeCursorVersion(value, ARCHIVED_TRANSCRIPT_CURSOR_VERSION);
  return decoded === null || decoded.fenceKind !== 1 ? null : decoded;
}

function encodeCursorVersion(input: DecodedTranscriptCursor, version: number): string {
  const bytes = Buffer.alloc(TRANSCRIPT_CURSOR_BYTES);
  bytes[0] = version;
  bytes[1] = input.fenceKind;
  input.chatDigest.copy(bytes, 2);
  input.fence.copy(bytes, 34);
  input.snapshotHash.copy(bytes, 66);
  bytes.writeBigUInt64BE(BigInt(input.snapshotEnd), 98);
  bytes.writeBigUInt64BE(BigInt(input.before), 106);
  return bytes.toString("base64url");
}

function encodeTranscriptCursor(input: DecodedTranscriptCursor): string {
  return encodeCursorVersion(input, TRANSCRIPT_CURSOR_VERSION);
}

function encodeArchivedTranscriptCursor(input: DecodedTranscriptCursor): string {
  return encodeCursorVersion(input, ARCHIVED_TRANSCRIPT_CURSOR_VERSION);
}

function transcriptPageTurn(record: TranscriptCompletedTurnRecord): TranscriptPageTurn {
  return {
    turnId: record.turnId,
    completedAt: record.completedAt,
    athleteText: record.athleteText,
    coachText: record.coachText,
  };
}

function restartRequiredPage(): TranscriptPageResult {
  return {
    schemaVersion: 1,
    status: "restart-required",
    turns: [],
    nextCursor: null,
  };
}

function pageResult(
  turns: readonly IndexedTranscriptTurn[],
  nextCursor: string | null,
): TranscriptPageResult {
  return {
    schemaVersion: 1,
    status: "page",
    turns: turns.map(({ record }) => transcriptPageTurn(record)),
    nextCursor,
  };
}

function encodedPageBytes(result: TranscriptPageResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function assertValidPageRequest(
  request: TranscriptPageRequest,
  decode: (value: string) => DecodedTranscriptCursor | null,
): void {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).length !== 2 ||
    !Object.hasOwn(request, "cursor") ||
    !Object.hasOwn(request, "limit") ||
    (request.cursor !== null && decode(request.cursor) === null) ||
    !Number.isSafeInteger(request.limit) ||
    request.limit < 1 ||
    request.limit > MAX_TRANSCRIPT_PAGE_TURNS
  ) {
    throw new TypeError("Transcript page request is invalid.");
  }
}

function backwardPage(
  turns: readonly IndexedTranscriptTurn[],
  cursor: DecodedTranscriptCursor,
  limit: number,
  encode: (cursor: DecodedTranscriptCursor) => string,
): TranscriptPageResult {
  const beforeIsValid =
    cursor.before === cursor.snapshotEnd || turns.some((turn) => turn.start === cursor.before);
  if (!beforeIsValid) throw new TypeError("Transcript page cursor is invalid.");
  let index = turns.length - 1;
  while (index >= 0 && turns[index]!.end > cursor.before) index -= 1;
  let selected: readonly IndexedTranscriptTurn[] = [];
  while (index >= 0 && selected.length < limit) {
    const tentative = [turns[index]!, ...selected];
    const hasMore = index > 0;
    const nextCursor = hasMore ? encode({ ...cursor, before: tentative[0]!.start }) : null;
    const tentativeResult = pageResult(tentative, nextCursor);
    if (encodedPageBytes(tentativeResult) > MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES) {
      if (selected.length === 0) {
        throw new Error("Transcript page record exceeds the response budget.");
      }
      break;
    }
    selected = tentative;
    index -= 1;
  }
  const nextCursor = index >= 0 ? encode({ ...cursor, before: selected[0]!.start }) : null;
  const result = pageResult(selected, nextCursor);
  if (encodedPageBytes(result) > MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES) {
    throw new Error("Transcript page exceeds the response budget.");
  }
  return result;
}

export class TranscriptStore implements TranscriptWriterPort {
  private readonly transcriptsDir: string;
  private readonly directoryIdentity: FileIdentity;
  private readonly hooks: TranscriptStoreHooks;

  constructor(dataDir: string, hooks: TranscriptStoreHooks = {}) {
    this.transcriptsDir = join(dataDir, "transcripts");
    this.hooks = hooks;
    let created = false;
    try {
      mkdirSync(this.transcriptsDir, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isExists(error)) throw error;
    }

    const beforeOpen = lstatSync(this.transcriptsDir);
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isDirectory()) {
      throw new UnsafeTranscriptTargetError();
    }
    const descriptor = openSync(
      this.transcriptsDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      if (created) fchmodSync(descriptor, 0o700);
      const opened = fstatSync(descriptor);
      if (
        !sameIdentity(identity(beforeOpen), identity(opened)) ||
        !opened.isDirectory() ||
        (opened.mode & 0o7777) !== 0o700
      ) {
        throw new UnsafeTranscriptTargetError();
      }
      const afterOpen = lstatSync(this.transcriptsDir);
      if (
        afterOpen.isSymbolicLink() ||
        !afterOpen.isDirectory() ||
        (afterOpen.mode & 0o7777) !== 0o700 ||
        !sameIdentity(identity(afterOpen), identity(opened))
      ) {
        throw new UnsafeTranscriptTargetError();
      }
      this.directoryIdentity = identity(opened);
      if (created) this.syncParentDirectory(dataDir);
    } finally {
      closeSync(descriptor);
    }
  }

  appendCompletedTurn(input: TranscriptCompletedTurnInput): void {
    const bytes = serializeTranscriptRecord(completedTurnRecord(input));
    this.appendRecord(input.chatId, bytes);
  }

  readCurrentConversation(chatId: string): TranscriptCompletedTurnRecord[] {
    return this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) return [];
      try {
        const contents = this.readSnapshot(descriptor);
        const window = parseCurrentWindow(contents, chatId);
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        return window.trusted ? window.turns.map(({ record }) => record) : [];
      } finally {
        closeSync(descriptor);
      }
    });
  }

  readCurrentConversationPage(
    chatId: string,
    request: TranscriptPageRequest,
  ): TranscriptPageResult {
    if (typeof chatId !== "string") throw new TypeError("Transcript page request is invalid.");
    assertValidPageRequest(request, decodeTranscriptCursor);
    return this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) {
        return request.cursor === null ? pageResult([], null) : restartRequiredPage();
      }
      try {
        const contents = this.readSnapshot(descriptor);
        const current = parseCurrentWindow(contents, chatId);
        const chatDigest = Buffer.from(this.chatDigest(chatId), "hex");
        let snapshot = contents;
        let snapshotWindow = current;
        let cursor: DecodedTranscriptCursor;
        if (request.cursor === null) {
          if (!current.trusted) {
            this.assertOpenedFileSafe(descriptor);
            this.assertDirectoryStable(directoryDescriptor);
            return pageResult([], null);
          }
          cursor = {
            fenceKind: current.fenceKind,
            chatDigest,
            fence: current.fence,
            snapshotHash: createHash("sha256").update(contents).digest(),
            snapshotEnd: contents.length,
            before: contents.length,
          };
        } else {
          const decoded = decodeTranscriptCursor(request.cursor);
          if (decoded === null || !decoded.chatDigest.equals(chatDigest)) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          if (
            !current.trusted ||
            current.fenceKind !== decoded.fenceKind ||
            !current.fence.equals(decoded.fence)
          ) {
            this.assertOpenedFileSafe(descriptor);
            this.assertDirectoryStable(directoryDescriptor);
            return restartRequiredPage();
          }
          if (decoded.snapshotEnd > contents.length) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          snapshot = contents.subarray(0, decoded.snapshotEnd);
          if (!createHash("sha256").update(snapshot).digest().equals(decoded.snapshotHash)) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          snapshotWindow = parseCurrentWindow(snapshot, chatId);
          if (
            !snapshotWindow.trusted ||
            snapshotWindow.fenceKind !== decoded.fenceKind ||
            !snapshotWindow.fence.equals(decoded.fence)
          ) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          cursor = decoded;
        }
        const result = backwardPage(
          snapshotWindow.turns,
          cursor,
          request.limit,
          encodeTranscriptCursor,
        );
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        return result;
      } finally {
        closeSync(descriptor);
      }
    });
  }

  listArchivedConversations(chatId: string): ArchivedConversationList {
    if (typeof chatId !== "string") {
      throw new TypeError("Archived conversation request is invalid.");
    }
    return this.withDirectory((directoryDescriptor): ArchivedConversationList => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) {
        return { schemaVersion: 1, conversations: [], truncated: false };
      }
      try {
        const contents = this.readSnapshot(descriptor);
        const segments = parseArchivedSegments(contents, chatId);
        const refs = new Set(segments.map((segment) => segment.boundary.resetId));
        if (refs.size !== segments.length) {
          throw new Error("Transcript contains duplicate reset boundaries.");
        }
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        const newestFirst = [...segments].reverse();
        const selected = newestFirst.slice(0, MAX_ARCHIVED_CONVERSATION_ENTRIES);
        return {
          schemaVersion: 1,
          conversations: selected.map((segment) => ({
            boundaryRef: segment.boundary.resetId,
            boundaryAt: segment.boundary.boundaryAt,
            reason: segment.boundary.reason,
            turnCount: segment.turns.length,
          })),
          truncated: newestFirst.length > selected.length,
        };
      } finally {
        closeSync(descriptor);
      }
    });
  }

  readArchivedConversationPage(
    chatId: string,
    boundaryRef: string,
    request: TranscriptPageRequest,
  ): TranscriptPageResult {
    if (
      typeof chatId !== "string" ||
      typeof boundaryRef !== "string" ||
      !RESET_ID_PATTERN.test(boundaryRef)
    ) {
      throw new TypeError("Archived transcript page request is invalid.");
    }
    assertValidPageRequest(request, decodeArchivedTranscriptCursor);
    return this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
      if (descriptor === null) return restartRequiredPage();
      try {
        const contents = this.readSnapshot(descriptor);
        const chatDigest = Buffer.from(this.chatDigest(chatId), "hex");
        const fence = Buffer.from(boundaryRef, "hex");
        let result: TranscriptPageResult;
        if (request.cursor === null) {
          const target = selectArchivedSegment(
            parseArchivedSegments(contents, chatId),
            boundaryRef,
          );
          if (target === null) {
            this.assertOpenedFileSafe(descriptor);
            this.assertDirectoryStable(directoryDescriptor);
            return restartRequiredPage();
          }
          result = backwardPage(
            target.turns,
            {
              fenceKind: 1,
              chatDigest,
              fence,
              snapshotHash: createHash("sha256")
                .update(contents.subarray(0, target.boundaryEnd))
                .digest(),
              snapshotEnd: target.boundaryEnd,
              before: target.boundaryEnd,
            },
            request.limit,
            encodeArchivedTranscriptCursor,
          );
        } else {
          const decoded = decodeArchivedTranscriptCursor(request.cursor);
          if (
            decoded === null ||
            !decoded.chatDigest.equals(chatDigest) ||
            !decoded.fence.equals(fence) ||
            decoded.snapshotEnd > contents.length
          ) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          const snapshot = contents.subarray(0, decoded.snapshotEnd);
          if (!createHash("sha256").update(snapshot).digest().equals(decoded.snapshotHash)) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          const target = selectArchivedSegment(
            parseArchivedSegments(snapshot, chatId),
            boundaryRef,
          );
          if (target === null || target.boundaryEnd !== decoded.snapshotEnd) {
            throw new TypeError("Transcript page cursor is invalid.");
          }
          result = backwardPage(
            target.turns,
            decoded,
            request.limit,
            encodeArchivedTranscriptCursor,
          );
        }
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        return result;
      } finally {
        closeSync(descriptor);
      }
    });
  }

  createResetIntent(input: ResetIntentRecord): void {
    const intent = resetIntentRecord(input);
    this.withDirectory((directoryDescriptor) => {
      this.reconcileResetTemps(directoryDescriptor, this.chatDigest(intent.chatId));
      const targetPath = this.intentPath(intent.chatId);
      const tempPath = this.intentTempPath(intent.chatId, intent.resetId);
      this.assertPathMissing(targetPath);
      this.assertPathMissing(tempPath);

      let tempDescriptor: number | null = null;
      let linked = false;
      try {
        tempDescriptor = this.openNewFile(directoryDescriptor, tempPath, 0, false);
        const bytes = Buffer.from(`${JSON.stringify(intent)}\n`, "utf8");
        this.writeComplete(tempDescriptor, bytes);
        this.syncFile(tempDescriptor);
        closeSync(tempDescriptor);
        tempDescriptor = null;

        this.assertPathMissing(targetPath);
        try {
          linkSync(tempPath, targetPath);
        } catch (error) {
          if (isExists(error)) throw new UnsafeTranscriptTargetError();
          throw error;
        }
        linked = true;
        this.syncDirectory(directoryDescriptor);
        this.unlinkMatchingTemp(directoryDescriptor, tempPath, targetPath);
        this.assertIntentTarget(directoryDescriptor, targetPath, intent);
      } catch (error) {
        if (tempDescriptor !== null) closeSync(tempDescriptor);
        try {
          if (linked) this.unlinkMatchingTemp(directoryDescriptor, tempPath, targetPath);
          else this.unlinkPrivateFileIfPresent(directoryDescriptor, tempPath, 1);
        } catch {
          // The caller will fail closed; construction/access recovery rechecks the artifact.
        }
        throw error;
      }
    });
  }

  readResetIntent(chatId: string): ResetIntentRecord | null {
    return this.withDirectory((directoryDescriptor) => {
      this.reconcileResetTemps(directoryDescriptor, this.chatDigest(chatId));
      return this.readIntentPath(directoryDescriptor, this.intentPath(chatId), chatId);
    });
  }

  listResetIntents(): ResetIntentRecord[] {
    return this.withDirectory((directoryDescriptor) => {
      this.reconcileResetTemps(directoryDescriptor);
      const names = readdirSync(this.transcriptsDir);
      this.assertDirectoryStable(directoryDescriptor);
      const intents: ResetIntentRecord[] = [];
      for (const name of names) {
        if (name.endsWith(".reset-intent.json") && !INTENT_TARGET_PATTERN.test(name)) {
          throw new UnsafeTranscriptTargetError();
        }
        const match = INTENT_TARGET_PATTERN.exec(name);
        if (match === null) continue;
        const path = join(this.transcriptsDir, name);
        const intent = this.readIntentPath(directoryDescriptor, path);
        if (intent === null || this.chatDigest(intent.chatId) !== match[1]) {
          throw new UnsafeTranscriptTargetError();
        }
        intents.push(intent);
      }
      return intents;
    });
  }

  removeResetIntent(expected: ResetIntentRecord): void {
    const intent = resetIntentRecord(expected);
    this.withDirectory((directoryDescriptor) => {
      this.reconcileResetTemps(directoryDescriptor, this.chatDigest(intent.chatId));
      const path = this.intentPath(intent.chatId);
      const descriptor = this.openExistingFile(
        directoryDescriptor,
        path,
        constants.O_RDONLY,
        false,
      );
      if (descriptor === null) return;
      try {
        const actual = parseResetIntent(readFileSync(descriptor));
        if (actual === null || JSON.stringify(actual) !== JSON.stringify(intent)) {
          throw new UnsafeTranscriptTargetError();
        }
        const pathStats = lstatSync(path);
        const openedStats = fstatSync(descriptor);
        if (!sameIdentity(identity(pathStats), identity(openedStats))) {
          throw new UnsafeTranscriptTargetError();
        }
        this.assertDirectoryStable(directoryDescriptor);
        unlinkSync(path);
        this.syncDirectory(directoryDescriptor);
      } finally {
        closeSync(descriptor);
      }
    });
  }

  hasConversationBoundary(chatId: string, resetId: string): boolean {
    if (!RESET_ID_PATTERN.test(resetId)) throw new TypeError("Reset identifier is invalid.");
    return this.boundaryCount(chatId, resetId) > 0;
  }

  ensureConversationBoundary(input: ResetIntentRecord): void {
    const intent = resetIntentRecord(input);
    const bytes = serializeTranscriptRecord(conversationBoundaryRecord(intent));
    const before = this.boundaryCount(intent.chatId, intent.resetId);
    if (before > 1) throw new Error("Transcript contains duplicate reset boundaries.");
    if (before === 1) {
      this.syncTranscriptFileAndDirectory(intent.chatId);
      return;
    }
    this.appendRecord(intent.chatId, bytes, true);
    if (this.boundaryCount(intent.chatId, intent.resetId) !== 1) {
      throw new Error("Conversation boundary was not durably persisted exactly once.");
    }
  }

  private boundaryCount(chatId: string, resetId: string): number {
    return this.withDirectory((directoryDescriptor) => {
      const descriptor = this.openExistingFile(
        directoryDescriptor,
        this.transcriptPath(chatId),
        constants.O_RDONLY,
        true,
      );
      if (descriptor === null) return 0;
      try {
        const contents = readFileSync(descriptor);
        let count = 0;
        let lineStart = 0;
        for (let index = 0; index < contents.length; index += 1) {
          if (contents[index] !== 0x0a) continue;
          const bytes = contents.subarray(lineStart, index);
          lineStart = index + 1;
          const record = bytes.length === 0 ? null : parseRecordBytes(bytes);
          if (
            record?.kind === "conversation-boundary" &&
            record.chatId === chatId &&
            record.resetId === resetId
          ) {
            count += 1;
          }
        }
        this.assertOpenedFileSafe(descriptor);
        this.assertDirectoryStable(directoryDescriptor);
        return count;
      } finally {
        closeSync(descriptor);
      }
    });
  }

  private appendRecord(
    chatId: string,
    recordBytes: Buffer,
    classifyUnchangedBoundaryFailure = false,
  ): void {
    this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const { descriptor, created } = this.openForAppend(directoryDescriptor, path);
      const beforeAppend = fstatSync(descriptor);
      try {
        let prefix = "";
        if (beforeAppend.size > 0) {
          const tail = Buffer.allocUnsafe(1);
          const bytesRead = readSync(descriptor, tail, 0, 1, beforeAppend.size - 1);
          if (bytesRead !== 1) throw new Error("Transcript tail could not be read.");
          if (tail[0] !== 0x0a) prefix = "\n";
        }
        const bytes =
          prefix === "" ? recordBytes : Buffer.concat([Buffer.from(prefix), recordBytes]);
        this.writeComplete(descriptor, bytes);
        this.syncFile(descriptor);
        this.assertOpenedPathSafe(directoryDescriptor, descriptor, path);
        this.syncDirectory(directoryDescriptor);
        this.assertOpenedPathSafe(directoryDescriptor, descriptor, path);
      } catch (error) {
        if (
          classifyUnchangedBoundaryFailure &&
          !created &&
          error instanceof IncompleteTranscriptWriteError &&
          error.bytesWritten === 0 &&
          this.openedPathIsUnchanged(directoryDescriptor, descriptor, path, beforeAppend)
        ) {
          throw new TranscriptBoundaryTargetUnchangedError(error);
        }
        throw error;
      } finally {
        closeSync(descriptor);
      }
    });
  }

  private syncTranscriptFileAndDirectory(chatId: string): void {
    this.withDirectory((directoryDescriptor) => {
      const path = this.transcriptPath(chatId);
      const descriptor = this.openExistingFile(
        directoryDescriptor,
        path,
        constants.O_RDONLY,
        false,
      );
      if (descriptor === null) throw new UnsafeTranscriptTargetError();
      try {
        this.syncFile(descriptor);
        this.assertOpenedPathSafe(directoryDescriptor, descriptor, path);
        this.syncDirectory(directoryDescriptor);
        this.assertOpenedPathSafe(directoryDescriptor, descriptor, path);
      } finally {
        closeSync(descriptor);
      }
    });
  }

  private readSnapshot(descriptor: number): Buffer {
    const size = fstatSync(descriptor).size;
    if (!Number.isSafeInteger(size) || size < 0) throw new UnsafeTranscriptTargetError();
    const contents = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(descriptor, contents, offset, size - offset, offset);
      if (bytesRead <= 0) throw new Error("Transcript snapshot could not be read.");
      offset += bytesRead;
    }
    return contents;
  }

  private openForAppend(
    directoryDescriptor: number,
    path: string,
  ): { readonly descriptor: number; readonly created: boolean } {
    const existing = this.openExistingFile(
      directoryDescriptor,
      path,
      constants.O_RDWR | constants.O_APPEND,
      true,
    );
    if (existing !== null) return { descriptor: existing, created: false };
    try {
      return {
        descriptor: this.openNewFile(directoryDescriptor, path, constants.O_APPEND, false),
        created: true,
      };
    } catch (error) {
      if (!isExists(error)) throw error;
      const raced = this.openExistingFile(
        directoryDescriptor,
        path,
        constants.O_RDWR | constants.O_APPEND,
        false,
      );
      if (raced === null) throw new UnsafeTranscriptTargetError();
      return { descriptor: raced, created: false };
    }
  }

  private openExistingFile(
    directoryDescriptor: number,
    path: string,
    flags: number,
    missingAllowed: boolean,
    allowedLinks: 1 | 2 = 1,
  ): number | null {
    let beforeOpen: Stats;
    try {
      beforeOpen = lstatSync(path);
    } catch (error) {
      if (missingAllowed && isMissing(error)) {
        this.assertDirectoryStable(directoryDescriptor);
        return null;
      }
      throw error;
    }
    if (beforeOpen.isSymbolicLink() || !isStrictPrivateFile(beforeOpen, allowedLinks)) {
      throw new UnsafeTranscriptTargetError();
    }
    this.hooks.beforeExistingFileOpen?.(path);
    this.assertDirectoryStable(directoryDescriptor);
    let descriptor: number;
    try {
      descriptor = openSync(path, flags | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ELOOP" || code === "EISDIR" || code === "ENOTDIR") {
        throw new UnsafeTranscriptTargetError();
      }
      throw error;
    }
    try {
      this.hooks.afterChildOpen?.(path, descriptor);
      this.assertDirectoryStable(directoryDescriptor);
      const opened = fstatSync(descriptor);
      if (
        !sameIdentity(identity(beforeOpen), identity(opened)) ||
        !isStrictPrivateFile(opened, allowedLinks)
      ) {
        throw new UnsafeTranscriptTargetError();
      }
      const afterOpen = lstatSync(path);
      if (
        !isStrictPrivateFile(afterOpen, allowedLinks) ||
        !sameIdentity(identity(afterOpen), identity(opened))
      ) {
        throw new UnsafeTranscriptTargetError();
      }
      this.assertDirectoryStable(directoryDescriptor);
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private openNewFile(
    directoryDescriptor: number,
    path: string,
    extraFlags = 0,
    syncOnCreate = true,
  ): number {
    this.assertDirectoryStable(directoryDescriptor);
    const descriptor = openSync(
      path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | extraFlags,
      0o600,
    );
    try {
      this.hooks.afterChildOpen?.(path, descriptor);
      this.assertDirectoryStable(directoryDescriptor);
      const created = fstatSync(descriptor);
      if (!created.isFile() || created.nlink !== 1) throw new UnsafeTranscriptTargetError();
      fchmodSync(descriptor, 0o600);
      const opened = fstatSync(descriptor);
      const afterOpen = lstatSync(path);
      if (
        !isStrictPrivateFile(opened) ||
        !isStrictPrivateFile(afterOpen) ||
        !sameIdentity(identity(afterOpen), identity(opened))
      ) {
        throw new UnsafeTranscriptTargetError();
      }
      this.assertDirectoryStable(directoryDescriptor);
      if (syncOnCreate) this.syncDirectory(directoryDescriptor);
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  private assertOpenedFileSafe(descriptor: number, allowedLinks: 1 | 2 = 1): void {
    if (!isStrictPrivateFile(fstatSync(descriptor), allowedLinks)) {
      throw new UnsafeTranscriptTargetError();
    }
  }

  private assertOpenedPathSafe(
    directoryDescriptor: number,
    descriptor: number,
    path: string,
    allowedLinks: 1 | 2 = 1,
  ): void {
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    if (
      !isStrictPrivateFile(opened, allowedLinks) ||
      !isStrictPrivateFile(current, allowedLinks) ||
      !sameIdentity(identity(opened), identity(current))
    ) {
      throw new UnsafeTranscriptTargetError();
    }
    this.assertDirectoryStable(directoryDescriptor);
  }

  private openedPathIsUnchanged(
    directoryDescriptor: number,
    descriptor: number,
    path: string,
    before: Stats,
  ): boolean {
    try {
      const opened = fstatSync(descriptor);
      const current = lstatSync(path);
      this.assertDirectoryStable(directoryDescriptor);
      return (
        isStrictPrivateFile(before) &&
        isStrictPrivateFile(opened) &&
        isStrictPrivateFile(current) &&
        sameIdentity(identity(before), identity(opened)) &&
        sameIdentity(identity(opened), identity(current)) &&
        before.size === opened.size &&
        before.mtimeMs === opened.mtimeMs &&
        before.ctimeMs === opened.ctimeMs
      );
    } catch {
      return false;
    }
  }

  private withDirectory<T>(operation: (descriptor: number) => T): T {
    const beforeOpen = lstatSync(this.transcriptsDir);
    if (
      beforeOpen.isSymbolicLink() ||
      !beforeOpen.isDirectory() ||
      (beforeOpen.mode & 0o7777) !== 0o700 ||
      !sameIdentity(identity(beforeOpen), this.directoryIdentity)
    ) {
      throw new UnsafeTranscriptTargetError();
    }
    const descriptor = openSync(
      this.transcriptsDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      this.assertDirectoryStable(descriptor);
      return operation(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private assertDirectoryStable(descriptor: number): void {
    const pathStats = lstatSync(this.transcriptsDir);
    const openedStats = fstatSync(descriptor);
    if (
      pathStats.isSymbolicLink() ||
      !pathStats.isDirectory() ||
      !openedStats.isDirectory() ||
      (pathStats.mode & 0o7777) !== 0o700 ||
      (openedStats.mode & 0o7777) !== 0o700 ||
      !sameIdentity(identity(pathStats), this.directoryIdentity) ||
      !sameIdentity(identity(openedStats), this.directoryIdentity)
    ) {
      throw new UnsafeTranscriptTargetError();
    }
  }

  private syncParentDirectory(dataDir: string): void {
    const descriptor = openSync(
      dataDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      this.syncDirectory(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private syncFile(descriptor: number): void {
    (this.hooks.syncFile ?? fsyncSync)(descriptor);
  }

  private syncDirectory(descriptor: number): void {
    (this.hooks.syncDirectory ?? fsyncSync)(descriptor);
  }

  private writeComplete(descriptor: number, bytes: Buffer): void {
    const written = (this.hooks.write ?? writeSync)(descriptor, bytes, 0, bytes.length, null);
    if (written !== bytes.length) throw new IncompleteTranscriptWriteError(written);
  }

  private assertPathMissing(path: string): void {
    try {
      lstatSync(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    throw new UnsafeTranscriptTargetError();
  }

  private assertIntentTarget(
    directoryDescriptor: number,
    path: string,
    expected: ResetIntentRecord,
  ): void {
    const actual = this.readIntentPath(directoryDescriptor, path, expected.chatId);
    if (actual === null || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new UnsafeTranscriptTargetError();
    }
  }

  private readIntentPath(
    directoryDescriptor: number,
    path: string,
    expectedChatId?: string,
  ): ResetIntentRecord | null {
    const descriptor = this.openExistingFile(directoryDescriptor, path, constants.O_RDONLY, true);
    if (descriptor === null) return null;
    try {
      const intent = parseResetIntent(readFileSync(descriptor));
      if (intent === null || (expectedChatId !== undefined && intent.chatId !== expectedChatId)) {
        throw new UnsafeTranscriptTargetError();
      }
      this.assertOpenedFileSafe(descriptor);
      this.assertDirectoryStable(directoryDescriptor);
      return intent;
    } finally {
      closeSync(descriptor);
    }
  }

  private reconcileResetTemps(directoryDescriptor: number, onlyDigest?: string): void {
    const names = readdirSync(this.transcriptsDir);
    this.assertDirectoryStable(directoryDescriptor);
    for (const name of names) {
      if (name.endsWith(".reset-intent.tmp") && !INTENT_TEMP_PATTERN.test(name)) {
        throw new UnsafeTranscriptTargetError();
      }
      const match = INTENT_TEMP_PATTERN.exec(name);
      if (match === null || (onlyDigest !== undefined && match[1] !== onlyDigest)) continue;
      const tempPath = join(this.transcriptsDir, name);
      const observedTemp = lstatSync(tempPath);
      const allowedLinks = observedTemp.nlink === 2 ? 2 : 1;
      const targetPath = join(this.transcriptsDir, `${match[1]}.reset-intent.json`);
      let targetStats: Stats | null = null;
      try {
        targetStats = lstatSync(targetPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const descriptor = this.openExistingFile(
        directoryDescriptor,
        tempPath,
        constants.O_RDONLY,
        false,
        allowedLinks,
      );
      if (descriptor === null) throw new UnsafeTranscriptTargetError();
      if (targetStats === null) {
        closeSync(descriptor);
        if (allowedLinks !== 1) throw new UnsafeTranscriptTargetError();
        this.unlinkPrivateFileIfPresent(directoryDescriptor, tempPath, 1);
        continue;
      }
      try {
        const tempStats = lstatSync(tempPath);
        if (
          allowedLinks !== 2 ||
          !isStrictPrivateFile(tempStats, 2) ||
          !isStrictPrivateFile(targetStats, 2) ||
          !sameIdentity(identity(tempStats), identity(targetStats))
        ) {
          throw new UnsafeTranscriptTargetError();
        }
        const intent = parseResetIntent(readFileSync(descriptor));
        if (
          intent === null ||
          this.chatDigest(intent.chatId) !== match[1] ||
          intent.resetId !== match[2]
        ) {
          throw new UnsafeTranscriptTargetError();
        }
      } finally {
        closeSync(descriptor);
      }
      this.unlinkMatchingTemp(directoryDescriptor, tempPath, targetPath);
    }
  }

  private unlinkMatchingTemp(
    directoryDescriptor: number,
    tempPath: string,
    targetPath: string,
  ): void {
    let tempStats: Stats;
    try {
      tempStats = lstatSync(tempPath);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    const targetStats = lstatSync(targetPath);
    if (
      !isStrictPrivateFile(tempStats, 2) ||
      !isStrictPrivateFile(targetStats, 2) ||
      !sameIdentity(identity(tempStats), identity(targetStats))
    ) {
      throw new UnsafeTranscriptTargetError();
    }
    this.assertDirectoryStable(directoryDescriptor);
    unlinkSync(tempPath);
    this.syncDirectory(directoryDescriptor);
  }

  private unlinkPrivateFileIfPresent(
    directoryDescriptor: number,
    path: string,
    links: 1 | 2,
  ): void {
    let stats: Stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (stats.isSymbolicLink() || !isStrictPrivateFile(stats, links)) {
      throw new UnsafeTranscriptTargetError();
    }
    this.assertDirectoryStable(directoryDescriptor);
    unlinkSync(path);
    this.syncDirectory(directoryDescriptor);
  }

  private transcriptPath(chatId: string): string {
    return join(this.transcriptsDir, `${this.chatDigest(chatId)}.jsonl`);
  }

  private intentPath(chatId: string): string {
    return join(this.transcriptsDir, `${this.chatDigest(chatId)}.reset-intent.json`);
  }

  private intentTempPath(chatId: string, resetId: string): string {
    return join(this.transcriptsDir, `${this.chatDigest(chatId)}.${resetId}.reset-intent.tmp`);
  }

  private chatDigest(chatId: string): string {
    return createHash("sha256").update(chatId, "utf8").digest("hex");
  }
}

TranscriptStore.prototype satisfies TranscriptWriterPort;
