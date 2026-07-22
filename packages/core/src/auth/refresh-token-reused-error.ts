import type { RefreshFailure } from "./refresh-failure.js";

export class RefreshTokenReusedError extends Error implements RefreshFailure {
  readonly refreshFailureReason = "reauth" as const;

  constructor(
    public readonly profile: string,
    cause: unknown,
  ) {
    super(
      `OAuth token for "${profile}" could not be refreshed — if this persists after checking your connection, re-run \`npm run setup\` or \`cycling-coach setup\` to reauthenticate.`,
    );
    this.name = "RefreshTokenReusedError";
    this.cause = cause;
  }
}
