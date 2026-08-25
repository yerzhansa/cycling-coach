import {
  AttachmentAdmissionReadModelSchema,
  type AdmitChatAttachmentRequest,
  type AttachmentAdmissionReadModel,
} from "@enduragent/coach-contract";

function displayNameFromPath(sourcePath: string): string {
  const segments = sourcePath.split(/[\\/]/u);
  return segments.at(-1) || "Attachment";
}

export function unavailableChatAttachmentAdmission(
  request: AdmitChatAttachmentRequest,
): AttachmentAdmissionReadModel {
  return AttachmentAdmissionReadModelSchema.parse({
    selectionId: request.selectionId,
    displayName: displayNameFromPath(request.candidate.sourcePath),
    status: "storage_failed",
    failureCode: "admission_unavailable",
    retryable: false,
  });
}
