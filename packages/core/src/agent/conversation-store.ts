import { randomBytes } from "node:crypto";
import type { ModelMessage } from "ai";
import type {
  ChatLineage,
  ChatStorePort,
  ConversationResetInput,
  TranscriptCompletedTurnInput,
  TranscriptWriterPort,
} from "@enduragent/engine";
import { archiveAndResetDurably, ChatStore } from "./chat-store.js";
import {
  TranscriptBoundaryTargetUnchangedError,
  TranscriptStore,
  type ArchivedConversationList,
  type ResetIntentRecord,
  type TranscriptCompletedTurnRecord,
  type TranscriptPageRequest,
  type TranscriptPageResult,
} from "./transcript-store.js";

export interface ConversationStorePort extends ChatStorePort, TranscriptWriterPort {
  readCurrentConversation(chatId: string): TranscriptCompletedTurnRecord[];
  readCurrentConversationPage(chatId: string, request: TranscriptPageRequest): TranscriptPageResult;
  listArchivedConversations(chatId: string): ArchivedConversationList;
  readArchivedConversationPage(
    chatId: string,
    boundaryRef: string,
    request: TranscriptPageRequest,
  ): TranscriptPageResult;
}

export interface ConversationStoreOptions {
  readonly platform?: NodeJS.Platform;
}

export function createConversationStore(
  dataDir: string,
  resetArchiveRetentionDays = 0,
  options: ConversationStoreOptions = {},
): ConversationStorePort {
  return ConversationStore.create(dataDir, resetArchiveRetentionDays, options);
}

export class ConversationRecoveryError extends Error {
  readonly code = "CONVERSATION_RECOVERY_REQUIRED";

  constructor(options: { readonly cause: unknown }) {
    super("Conversation storage recovery could not be completed.", options);
    this.name = "ConversationRecoveryError";
  }
}

export class ConversationStore implements ConversationStorePort {
  private readonly blockedChats = new Map<string, unknown>();

  static create(
    dataDir: string,
    resetArchiveRetentionDays = 0,
    options: ConversationStoreOptions = {},
  ): ConversationStore {
    return new ConversationStore(
      new ChatStore(dataDir, resetArchiveRetentionDays, options),
      new TranscriptStore(dataDir, { platform: options.platform }),
    );
  }

  constructor(
    private readonly chatStore: ChatStore,
    private readonly transcriptStore: TranscriptStore,
    private readonly createResetId: () => string = () => randomBytes(32).toString("hex"),
  ) {
    for (const intent of this.transcriptStore.listResetIntents()) {
      try {
        this.recoverIntent(intent);
      } catch (error) {
        this.blockedChats.set(intent.chatId, error);
      }
    }
  }

  hasSession(chatId: string): boolean {
    this.recoverBeforeAccess(chatId);
    return this.chatStore.hasSession(chatId);
  }

  load(chatId: string): { messages: ModelMessage[]; lastMessageTime: string | null } {
    this.recoverBeforeAccess(chatId);
    return this.chatStore.load(chatId);
  }

  appendTurn(
    chatId: string,
    userContent: string,
    assistantContent: string,
    lineage: ChatLineage,
  ): void {
    this.recoverBeforeAccess(chatId);
    this.chatStore.appendTurn(chatId, userContent, assistantContent, lineage);
  }

  overwriteHistory(chatId: string, messages: ModelMessage[]): void {
    this.recoverBeforeAccess(chatId);
    this.chatStore.overwriteHistory(chatId, messages);
  }

  archivePreCompact(chatId: string): void {
    this.recoverBeforeAccess(chatId);
    this.chatStore.archivePreCompact(chatId);
  }

  appendCompletedTurn(input: TranscriptCompletedTurnInput): void {
    this.recoverBeforeAccess(input.chatId);
    this.transcriptStore.appendCompletedTurn(input);
  }

  readCurrentConversation(chatId: string) {
    this.recoverBeforeAccess(chatId);
    return this.transcriptStore.readCurrentConversation(chatId);
  }

  readCurrentConversationPage(chatId: string, request: TranscriptPageRequest) {
    return this.transcriptStore.readCurrentConversationPage(chatId, request);
  }

  listArchivedConversations(chatId: string) {
    return this.transcriptStore.listArchivedConversations(chatId);
  }

  readArchivedConversationPage(
    chatId: string,
    boundaryRef: string,
    request: TranscriptPageRequest,
  ) {
    return this.transcriptStore.readArchivedConversationPage(chatId, boundaryRef, request);
  }

  resetConversation(input: ConversationResetInput): void {
    this.recoverBeforeAccess(input.chatId);
    const intent: ResetIntentRecord = {
      version: 1,
      kind: "conversation-reset-intent",
      resetId: this.createResetId(),
      chatId: input.chatId,
      boundaryAt: input.boundaryAt,
      reason: input.reason,
    };

    try {
      this.transcriptStore.createResetIntent(intent);
    } catch (error) {
      this.cleanupBeforeBoundary(intent, error);
    }

    try {
      this.transcriptStore.ensureConversationBoundary(intent);
    } catch (error) {
      if (error instanceof TranscriptBoundaryTargetUnchangedError) {
        this.cleanupBeforeBoundary(intent, error.originalError);
      }
      this.blockedChats.set(intent.chatId, error);
      throw error;
    }

    try {
      archiveAndResetDurably(this.chatStore, intent.chatId, {
        resetId: intent.resetId,
        boundaryAt: intent.boundaryAt,
      });
      this.transcriptStore.removeResetIntent(intent);
      this.blockedChats.delete(intent.chatId);
    } catch (error) {
      this.blockedChats.set(intent.chatId, error);
      throw error;
    }
  }

  private cleanupBeforeBoundary(intent: ResetIntentRecord, originalError: unknown): never {
    try {
      const stored = this.transcriptStore.readResetIntent(intent.chatId);
      if (stored !== null) {
        if (JSON.stringify(stored) !== JSON.stringify(intent)) {
          throw new Error("A different conversation reset intent is already pending.");
        }
        this.transcriptStore.removeResetIntent(stored);
      }
      this.blockedChats.delete(intent.chatId);
    } catch (cleanupError) {
      this.blockedChats.set(intent.chatId, cleanupError);
      throw new ConversationRecoveryError({ cause: cleanupError });
    }
    throw originalError;
  }

  private recoverBeforeAccess(chatId: string): void {
    try {
      const intent = this.transcriptStore.readResetIntent(chatId);
      if (intent !== null) this.recoverIntent(intent);
      this.blockedChats.delete(chatId);
    } catch (error) {
      this.blockedChats.set(chatId, error);
      throw new ConversationRecoveryError({ cause: error });
    }
  }

  private recoverIntent(intent: ResetIntentRecord): void {
    this.transcriptStore.ensureConversationBoundary(intent);
    archiveAndResetDurably(this.chatStore, intent.chatId, {
      resetId: intent.resetId,
      boundaryAt: intent.boundaryAt,
    });
    this.transcriptStore.removeResetIntent(intent);
  }
}

ConversationStore.prototype satisfies ChatStorePort;
ConversationStore.prototype satisfies TranscriptWriterPort;
