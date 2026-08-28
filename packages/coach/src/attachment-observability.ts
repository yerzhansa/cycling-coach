import type { LoggerPort } from "@enduragent/engine";
import type { ChatAttachmentKind } from "@enduragent/kernel/store";

export type AttachmentObservationOperation =
  | "admission"
  | "preprocess"
  | "import"
  | "cleanup"
  | "reconcile";

export type AttachmentObservationResult =
  | "admission_unavailable"
  | "accepted"
  | "blocked"
  | "empty_file"
  | "failed"
  | "file_too_large"
  | "format_unsupported"
  | "message_limit"
  | "ready"
  | "signature_mismatch"
  | "storage_failed"
  | "storage_full"
  | "succeeded"
  | "unsafe_source"
  | "validation_failed";

export interface AttachmentObservation {
  readonly operation: AttachmentObservationOperation;
  readonly kind: ChatAttachmentKind | "unknown";
  readonly result: AttachmentObservationResult;
  readonly byteSize?: number;
  readonly durationMs?: number;
  readonly count?: number;
  readonly parserVersion?: string;
}

const SAFE_PARSER_VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

export function attachmentByteBucket(byteSize: number | undefined): string {
  if (byteSize === undefined || !Number.isSafeInteger(byteSize) || byteSize < 0) return "unknown";
  if (byteSize < 1_024) return "lt_1_kib";
  if (byteSize < 1_048_576) return "lt_1_mib";
  if (byteSize < 10_485_760) return "lt_10_mib";
  if (byteSize < 104_857_600) return "lt_100_mib";
  return "gte_100_mib";
}

export function attachmentDurationBucket(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "unknown";
  if (durationMs < 10) return "lt_10_ms";
  if (durationMs < 100) return "lt_100_ms";
  if (durationMs < 1_000) return "lt_1_s";
  if (durationMs < 10_000) return "lt_10_s";
  return "gte_10_s";
}

export function attachmentCountBucket(count: number | undefined): string {
  if (count === undefined || !Number.isSafeInteger(count) || count < 0) return "unknown";
  if (count === 0) return "0";
  if (count === 1) return "1";
  if (count <= 5) return "2_5";
  if (count <= 20) return "6_20";
  return "gte_21";
}

export function observeChatAttachment(logger: LoggerPort, input: AttachmentObservation): void {
  const parserVersion =
    input.parserVersion !== undefined && SAFE_PARSER_VERSION.test(input.parserVersion)
      ? input.parserVersion
      : undefined;
  try {
    logger.info("chat_attachment_operation", {
      operation: input.operation,
      kind: input.kind,
      result_code: input.result,
      byte_bucket: attachmentByteBucket(input.byteSize),
      duration_bucket: attachmentDurationBucket(input.durationMs),
      count_bucket: attachmentCountBucket(input.count),
      ...(parserVersion === undefined ? {} : { parser_version: parserVersion }),
    });
  } catch {
    // Diagnostics must never break attachment admission, parsing, import, or cleanup.
  }
}
