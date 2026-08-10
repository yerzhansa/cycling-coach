export type PrivatePathEntryType = "file" | "directory" | "other";

export type PrivatePathExpectedEntryType = Exclude<PrivatePathEntryType, "other">;

export type PrivatePathPolicyErrorCategory =
  | "corruption"
  | "sharing-violation"
  | "entry-type"
  | "link-reparse-shaped"
  | "io-failure";

export type PrivatePathPolicyDecision =
  | Readonly<{ kind: "accept" }>
  | Readonly<{ kind: "reject"; category: PrivatePathPolicyErrorCategory }>;

export type PrivatePathPlatformSemantics = "windows" | "posix";

export type PrivatePathDurabilityStage =
  | "content-write"
  | "file-flush"
  | "rename"
  | "directory-sync";

export type PrivatePathDurabilityClassification =
  | Readonly<{ kind: "required" }>
  | Readonly<{ kind: "unavailable" }>;

export interface PrivatePathDurabilityInput {
  readonly platform: PrivatePathPlatformSemantics;
  readonly stage: PrivatePathDurabilityStage;
}

export interface PrivatePathEntryDecisionInput {
  readonly expectedType: PrivatePathExpectedEntryType;
  readonly actualType: PrivatePathEntryType;
  readonly linkOrReparseShaped: boolean;
}

export interface PrivatePathBindingDecisionInput {
  readonly identityStable: boolean;
  readonly authenticatedHomeBinding: boolean;
}

export interface PrivatePathRootDecisionInput extends PrivatePathBindingDecisionInput {
  readonly ordinary: boolean;
}

export interface PrivatePathReadDecisionInput extends PrivatePathBindingDecisionInput {
  readonly bounded: boolean;
  readonly contentValid: boolean;
}

const ACCEPT = Object.freeze({ kind: "accept" } as const);
const REQUIRED = Object.freeze({ kind: "required" } as const);
const UNAVAILABLE = Object.freeze({ kind: "unavailable" } as const);
const CORRUPTION = Object.freeze({ kind: "reject", category: "corruption" } as const);
const ENTRY_TYPE = Object.freeze({ kind: "reject", category: "entry-type" } as const);
const LINK_REPARSE_SHAPED = Object.freeze({
  kind: "reject",
  category: "link-reparse-shaped",
} as const);

export function classifyPrivatePathDurability({
  platform,
  stage,
}: PrivatePathDurabilityInput): PrivatePathDurabilityClassification {
  if (platform === "windows" && stage === "directory-sync") return UNAVAILABLE;
  return REQUIRED;
}

export function classifyPrivatePathErrorCode(
  code: unknown,
): Extract<PrivatePathPolicyErrorCategory, "sharing-violation" | "io-failure"> {
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    return "sharing-violation";
  }
  return "io-failure";
}

export function decidePrivatePathEntry({
  expectedType,
  actualType,
  linkOrReparseShaped,
}: PrivatePathEntryDecisionInput): PrivatePathPolicyDecision {
  if (linkOrReparseShaped) return LINK_REPARSE_SHAPED;
  if (actualType !== expectedType) return ENTRY_TYPE;
  return ACCEPT;
}

export function decidePrivatePathBinding({
  identityStable,
  authenticatedHomeBinding,
}: PrivatePathBindingDecisionInput): PrivatePathPolicyDecision {
  if (!identityStable || !authenticatedHomeBinding) return CORRUPTION;
  return ACCEPT;
}

export function decidePrivatePathRoot({
  ordinary,
  identityStable,
  authenticatedHomeBinding,
}: PrivatePathRootDecisionInput): PrivatePathPolicyDecision {
  if (!ordinary) return CORRUPTION;
  return decidePrivatePathBinding({ identityStable, authenticatedHomeBinding });
}

export function decidePrivatePathRead({
  bounded,
  identityStable,
  contentValid,
  authenticatedHomeBinding,
}: PrivatePathReadDecisionInput): PrivatePathPolicyDecision {
  if (!bounded || !contentValid) return CORRUPTION;
  return decidePrivatePathBinding({ identityStable, authenticatedHomeBinding });
}
