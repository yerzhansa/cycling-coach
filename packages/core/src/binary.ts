/**
 * Per-binary deployment-shell configuration. Setup wizard, env-var resolution,
 * and keychain entry naming all key off these fields. Lets one Sport ship as
 * multiple binaries (e.g., `cycling-coach`, `running-coach`) without baking
 * sport-specific names into Core's setup flow. Per ADR-0001 and ADR-0006.
 */
export interface BinaryConfig {
  /** npm package name + CLI invocation name, e.g. "cycling-coach". */
  binaryName: string;

  /** Human-readable name for prompts and outro messages, e.g. "Cycling Coach". */
  displayName: string;

  /** Subdir under `~/.enduragent/` for fresh installs, e.g. "cycling". */
  dataSubdir: string;

  /** Prefix for Apple Keychain generic-password items, e.g. "cycling-coach". */
  keychainPrefix: string;

  /** Env var name for data-dir override, e.g. "CYCLING_COACH_HOME". */
  homeEnvVar: string;
}
