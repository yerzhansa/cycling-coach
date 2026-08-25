export type ChatAttachmentKind = "document" | "activity" | "workout" | "image";
export type ChatAttachmentStatus =
  | "preprocessing"
  | "blocked"
  | "failed"
  | "ready"
  | "importing"
  | "imported"
  | "sent";
export type ChatAttachmentDraftState = "active" | "restored" | "submitting" | "clearing";

export interface ChatAttachmentCapacityLimits {
  readonly attachmentsPerMessage: number;
  readonly messageBytes: number;
  readonly conversationBytes: number;
  readonly athleteBytes: number;
}

export interface ChatAttachmentObjectRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly conversation_key: string;
  readonly sha256: string;
  readonly byte_size: number;
  readonly relative_path: string;
  readonly status: "reserved" | "durable" | "failed";
  readonly failure_code: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface ChatAttachmentRow {
  readonly id: string;
  readonly schema_version: 1;
  readonly conversation_id: string;
  readonly object_id: string;
  readonly kind: ChatAttachmentKind;
  readonly display_name: string;
  readonly media_type: string;
  readonly extension: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly status: ChatAttachmentStatus;
  readonly state_json: string | null;
  readonly message_id: string | null;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface ChatAttachmentDraft {
  readonly schemaVersion: 1;
  readonly conversationId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  readonly state: ChatAttachmentDraftState;
  readonly updatedAtMs: number;
}

export type ChatAttachmentObjectReservation =
  | { readonly kind: "reserved"; readonly object: ChatAttachmentObjectRow }
  | { readonly kind: "reused"; readonly object: ChatAttachmentObjectRow }
  | { readonly kind: "message_limit" }
  | { readonly kind: "storage_full"; readonly scope: "conversation" | "athlete" };

export interface ChatAttachmentRepository {
  reserveObject(input: {
    readonly object: ChatAttachmentObjectRow;
    readonly limits: ChatAttachmentCapacityLimits;
  }): Promise<ChatAttachmentObjectReservation>;
  commitAdmission(input: {
    readonly objectId: string;
    readonly attachment: ChatAttachmentRow;
    readonly draftUpdatedAtMs: number;
  }): Promise<ChatAttachmentDraft>;
  failObject(objectId: string, failureCode: string, updatedAtMs: number): Promise<void>;
  readObject(objectId: string): Promise<ChatAttachmentObjectRow | undefined>;
  readAttachment(attachmentId: string): Promise<ChatAttachmentRow | undefined>;
  readDraft(conversationId: string): Promise<ChatAttachmentDraft | undefined>;
  saveDraftText(input: {
    readonly conversationId: string;
    readonly text: string;
    readonly state: ChatAttachmentDraftState;
    readonly updatedAtMs: number;
  }): Promise<ChatAttachmentDraft | undefined>;
  removeDraftAttachment(input: {
    readonly conversationId: string;
    readonly attachmentId: string;
  }): Promise<{
    readonly draft?: ChatAttachmentDraft;
    readonly unreferencedObject?: ChatAttachmentObjectRow;
  }>;
  linkMessage(input: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly attachmentIds: readonly string[];
    readonly createdAtMs: number;
  }): Promise<void>;
  listMessageAttachments(messageId: string): Promise<readonly ChatAttachmentRow[]>;
  listObjects(): Promise<readonly ChatAttachmentObjectRow[]>;
  markObjectMissing(objectId: string, updatedAtMs: number): Promise<void>;
  cleanupConversation(conversationId: string): Promise<readonly ChatAttachmentObjectRow[]>;
  hasObject(objectId: string): Promise<boolean>;
  deleteFailedObject(objectId: string): Promise<void>;
}

export class ChatAttachmentInvariantError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ChatAttachmentInvariantError";
  }
}
