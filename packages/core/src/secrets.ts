/**
 * Sport-agnostic secrets resolution. Sports receive a `SecretsResolver`
 * via CoreDeps and never see backend specifics (env, exec, 1Password, etc.).
 */

export type ExecSecretRef = { source: "exec"; command: string; args?: string[] };
export type EnvSecretRef = { source: "env"; var: string };
export type SecretRef = ExecSecretRef | EnvSecretRef;

export interface SecretsResolver {
  resolve(ref: SecretRef): Promise<string>;
}
