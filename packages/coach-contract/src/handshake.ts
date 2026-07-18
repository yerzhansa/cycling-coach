import { z } from "zod";
import { PROTOCOL_VERSION } from "./version.js";

export const DaemonOwnerSchema = z.enum([
  "service-managed",
  "ephemeral-client-started",
  "unmanaged-foreground",
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

export const ClientHandshakeFrameSchema = z
  .object({
    type: z.literal("handshake"),
    token: z.string().min(1),
    clientProtocolVersion: ProtocolVersionNumberSchema,
  })
  .strict();
export type ClientHandshakeFrame = z.infer<typeof ClientHandshakeFrameSchema>;

export const ServerHandshakeFrameSchema = z
  .discriminatedUnion("status", [
    z
      .object({
        type: z.literal("handshake"),
        status: z.literal("accepted"),
        clientProtocolVersion: ProtocolVersionNumberSchema,
        serverProtocolVersion: ProtocolVersionNumberSchema,
        owner: DaemonOwnerSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("handshake"),
        status: z.literal("version-mismatch"),
        clientProtocolVersion: ProtocolVersionNumberSchema,
        serverProtocolVersion: ProtocolVersionNumberSchema,
        direction: ProtocolVersionDirectionSchema,
        owner: DaemonOwnerSchema,
      })
      .strict(),
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
