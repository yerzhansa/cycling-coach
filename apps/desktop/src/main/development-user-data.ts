import { isAbsolute, normalize } from "node:path";
import type { App } from "electron";

export const DEVELOPMENT_USER_DATA_ENV = "ENDURAGENT_DEVELOPMENT_USER_DATA" as const;

export type DevelopmentUserDataDecision =
  | Readonly<{ kind: "no-op" }>
  | Readonly<{ kind: "bind"; path: string }>;

export type DevelopmentUserDataAppPort = Pick<App, "setPath">;

export interface DevelopmentUserDataDecisionInput {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

function validAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    isAbsolute(value) &&
    normalize(value) === value
  );
}

export function decideDevelopmentUserDataBinding(
  input: DevelopmentUserDataDecisionInput,
): DevelopmentUserDataDecision {
  const path = input.environment[DEVELOPMENT_USER_DATA_ENV];
  if (path === undefined) return Object.freeze({ kind: "no-op" });
  if (
    input.platform !== "darwin" ||
    input.isPackaged ||
    input.environment.ENDURAGENT_ACCEPTANCE_CREDENTIAL_BACKEND !== "memory" ||
    input.environment.ENDURAGENT_DISPOSABLE_SAFE_STORAGE_CONTEXT !== "1" ||
    !validAbsolutePath(path)
  ) {
    throw new TypeError("isolated development user data binding refused");
  }
  return Object.freeze({ kind: "bind", path });
}

export function bindDevelopmentUserData(
  app: DevelopmentUserDataAppPort,
  options: Partial<DevelopmentUserDataDecisionInput> = {},
): DevelopmentUserDataDecision {
  const decision = decideDevelopmentUserDataBinding({
    platform: options.platform ?? process.platform,
    isPackaged: options.isPackaged ?? false,
    environment: options.environment ?? process.env,
  });
  if (decision.kind === "bind") app.setPath("userData", decision.path);
  return decision;
}
