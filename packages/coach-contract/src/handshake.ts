import { z } from "zod";
import { PROTOCOL_VERSION } from "./version.js";

export const DaemonOwnerSchema = z.enum([
  "service-managed",
  "ephemeral-client-started",
  "unmanaged-foreground",
  "app-supervised",
]);
export type DaemonOwner = z.infer<typeof DaemonOwnerSchema>;

export const ProtocolVersionDirectionSchema = z.enum(["client-older", "client-newer"]);
export type ProtocolVersionDirection = z.infer<typeof ProtocolVersionDirectionSchema>;

export const ProtocolVersionNumberSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
export type ProtocolVersionNumber = z.infer<typeof ProtocolVersionNumberSchema>;

function isCanonicalAbsoluteAthleteHome(value: string): boolean {
  if (value.includes("\0")) return false;
  if (value === "/") return true;
  if (value.startsWith("/")) {
    if (value.endsWith("/") || value.includes("//")) return false;
    return value
      .slice(1)
      .split("/")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..");
  }
  if (/^[A-Za-z]:\\$/.test(value)) return true;
  if (/^[A-Za-z]:\\/.test(value)) {
    if (value.endsWith("\\") || value.includes("/")) return false;
    return value
      .slice(3)
      .split("\\")
      .every((segment) => segment !== "" && segment !== "." && segment !== "..");
  }
  if (value.startsWith("\\\\")) {
    if (value.endsWith("\\") || value.includes("/")) return false;
    const segments = value.slice(2).split("\\");
    return (
      segments.length >= 2 &&
      segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
  }
  return false;
}

export const AthleteHomeIdentitySchema = z
  .string()
  .min(1)
  .max(32_767)
  .refine(isCanonicalAbsoluteAthleteHome, "athlete home must be a canonical absolute path");
export type AthleteHomeIdentity = z.infer<typeof AthleteHomeIdentitySchema>;

export const RendererCapabilitySchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
export type RendererCapability = z.infer<typeof RendererCapabilitySchema>;

export const AcceptedServerHandshakeBindingSchema = z
  .object({
    athleteHome: AthleteHomeIdentitySchema,
    rendererCapability: RendererCapabilitySchema,
  })
  .strict();
export type AcceptedServerHandshakeBinding = z.infer<typeof AcceptedServerHandshakeBindingSchema>;

export const ClientHandshakeFrameSchema = z
  .object({
    type: z.literal("handshake"),
    token: z.string().min(1),
    clientProtocolVersion: ProtocolVersionNumberSchema,
  })
  .strict();
export type ClientHandshakeFrame = z.infer<typeof ClientHandshakeFrameSchema>;

export const Protocol11AcceptedServerHandshakeFrameSchema = z
  .object({
    type: z.literal("handshake"),
    status: z.literal("accepted"),
    clientProtocolVersion: z.literal(11),
    serverProtocolVersion: z.literal(11),
    owner: DaemonOwnerSchema,
  })
  .strict();
export type Protocol11AcceptedServerHandshakeFrame = z.infer<
  typeof Protocol11AcceptedServerHandshakeFrameSchema
>;

export const AcceptedServerHandshakeFrameSchema = z
  .object({
    type: z.literal("handshake"),
    status: z.literal("accepted"),
    clientProtocolVersion: z.literal(PROTOCOL_VERSION),
    serverProtocolVersion: z.literal(PROTOCOL_VERSION),
    owner: DaemonOwnerSchema,
    athleteHome: AthleteHomeIdentitySchema,
    rendererCapability: RendererCapabilitySchema,
  })
  .strict();

export const VersionMismatchServerHandshakeFrameSchema = z
  .object({
    type: z.literal("handshake"),
    status: z.literal("version-mismatch"),
    clientProtocolVersion: ProtocolVersionNumberSchema,
    serverProtocolVersion: ProtocolVersionNumberSchema,
    direction: ProtocolVersionDirectionSchema,
    owner: DaemonOwnerSchema,
  })
  .strict();

export const ServerHandshakeFrameSchema = z
  .discriminatedUnion("status", [
    AcceptedServerHandshakeFrameSchema,
    VersionMismatchServerHandshakeFrameSchema,
  ])
  .superRefine((value, context) => {
    const comparison = compareProtocolVersions(
      value.clientProtocolVersion,
      value.serverProtocolVersion,
    );
    if (value.status === "accepted" && comparison !== "equal") {
      context.addIssue({ code: "custom", message: "accepted versions must match" });
    }
    if (value.status === "version-mismatch" && comparison !== value.direction) {
      context.addIssue({
        code: "custom",
        path: ["direction"],
        message: "version direction does not match compared versions",
      });
    }
  });
export type ServerHandshakeFrame = z.infer<typeof ServerHandshakeFrameSchema>;

export type ProtocolVersionComparison = "equal" | ProtocolVersionDirection;

export function compareProtocolVersions(
  clientProtocolVersion: number,
  serverProtocolVersion: number,
): ProtocolVersionComparison {
  ProtocolVersionNumberSchema.parse(clientProtocolVersion);
  ProtocolVersionNumberSchema.parse(serverProtocolVersion);
  if (clientProtocolVersion < serverProtocolVersion) return "client-older";
  if (clientProtocolVersion > serverProtocolVersion) return "client-newer";
  return "equal";
}

export type AcceptedServerHandshakeFrame = Extract<ServerHandshakeFrame, { status: "accepted" }>;
export type VersionMismatchServerHandshakeFrame = Extract<
  ServerHandshakeFrame,
  { status: "version-mismatch" }
>;

export function createClientHandshakeFrame(token: string): ClientHandshakeFrame {
  return ClientHandshakeFrameSchema.parse({
    type: "handshake",
    token,
    clientProtocolVersion: PROTOCOL_VERSION,
  });
}

export function createAcceptedServerHandshakeFrame(
  owner: DaemonOwner,
  clientProtocolVersion: number,
  binding: AcceptedServerHandshakeBinding,
  serverProtocolVersion: number = PROTOCOL_VERSION,
): AcceptedServerHandshakeFrame {
  if (compareProtocolVersions(clientProtocolVersion, serverProtocolVersion) !== "equal") {
    throw new Error("accepted versions must match");
  }
  return ServerHandshakeFrameSchema.parse({
    type: "handshake",
    status: "accepted",
    clientProtocolVersion,
    serverProtocolVersion,
    owner,
    ...binding,
  }) as AcceptedServerHandshakeFrame;
}

export function createVersionMismatchServerHandshakeFrame(
  owner: DaemonOwner,
  clientProtocolVersion: number,
  serverProtocolVersion: number = PROTOCOL_VERSION,
): VersionMismatchServerHandshakeFrame {
  const direction = compareProtocolVersions(clientProtocolVersion, serverProtocolVersion);
  if (direction === "equal") {
    throw new Error("version mismatch requires unequal versions");
  }
  return ServerHandshakeFrameSchema.parse({
    type: "handshake",
    status: "version-mismatch",
    clientProtocolVersion,
    serverProtocolVersion,
    direction,
    owner,
  }) as VersionMismatchServerHandshakeFrame;
}
