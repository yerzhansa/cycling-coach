import { intro, outro, select, text, password, confirm, isCancel, cancel, log } from "@clack/prompts";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { stringify as toYaml } from "yaml";
import {
  CONFIG_DIR,
  CONFIG_FILE,
  KeychainUnsafeValueError,
  OpVaultAmbiguousError,
  SecretTooLargeError,
  detectBackends,
  isSecretRef,
  keychainItemDelete,
  keychainItemExists,
  keychainItemUpsert,
  keychainLoginPath,
  keychainSecretRef,
  loadProfile,
  opItemCreate,
  opItemDelete,
  opItemGet,
  opItemUpdate,
  opSecretRef,
  opVaultList,
  readConfigYaml,
  runCodexLogin,
  saveProfile,
  type BackendAvailability,
  type OAuthCredential,
  type OpState,
  type SecretRef,
} from "@enduragent/core";

// ============================================================================
// TYPES
// ============================================================================

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI (GPT)" },
  { value: "google", label: "Google (Gemini)" },
  { value: "openai-codex", label: "OpenAI Codex (ChatGPT subscription)", hint: "experimental" },
];

const API_KEY_LABELS: Record<string, string> = {
  anthropic: "Anthropic API key",
  openai: "OpenAI API key",
  google: "Google AI API key",
};

const MODELS: Record<string, { value: string; label: string; hint?: string }[]> = {
  anthropic: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "recommended" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", hint: "fast & cheap" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6", hint: "most capable" },
  ],
  openai: [
    { value: "gpt-5.4", label: "GPT-5.4", hint: "recommended" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "fast & cheap" },
    { value: "gpt-5.4-nano", label: "GPT-5.4 Nano", hint: "cheapest" },
    { value: "o4-mini", label: "o4-mini", hint: "reasoning" },
  ],
  google: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", hint: "recommended" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", hint: "most capable" },
    { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", hint: "cheapest" },
  ],
  "openai-codex": [
    { value: "gpt-5.4", label: "GPT-5.4", hint: "recommended" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", hint: "faster" },
  ],
};

const CUSTOM_MODEL_SENTINEL = "__custom__";
const BACKEND_PLAIN = "plain";
const BACKEND_OP = "op";
const BACKEND_KEYCHAIN = "keychain";
const BACKEND_OP_SIGNIN = "op-signin";

export type BackendChoice = "plain" | "op" | "keychain";

type SecretFieldPath = "llm.api_key" | "intervals.api_key" | "telegram.bot_token";

export type CreatedEntry = {
  backend: "op" | "keychain";
  field: SecretFieldPath;
  title: string;
  vaultName?: string;
  keychainPath?: string;
  opAbsPath?: string;
  preExistedBeforeWizard: boolean;
};

export type WizardCtx = {
  createdThisRun: CreatedEntry[];
};

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-5.4",
  google: "gemini-2.5-flash",
  "openai-codex": "gpt-5.4",
};

const FIELD_TITLES: Record<SecretFieldPath, string> = {
  "llm.api_key": "cycling-coach · llm_api_key",
  "intervals.api_key": "cycling-coach · intervals_api_key",
  "telegram.bot_token": "cycling-coach · telegram_bot_token",
};

const FIELD_KEYCHAIN_ACCOUNT: Record<SecretFieldPath, string> = {
  "llm.api_key": "llm_api_key",
  "intervals.api_key": "intervals_api_key",
  "telegram.bot_token": "telegram_bot_token",
};

// ============================================================================
// PURE HELPERS (exported with leading underscore for direct testability)
// ============================================================================

export function _detectPrevBackend(value: unknown): BackendChoice | "unknown" {
  if (typeof value === "string") return "plain";
  if (isSecretRef(value)) {
    if (value.source === "env") return "unknown";
    const cmd = value.command;
    if (cmd === "op" || cmd.endsWith("/op")) return "op";
    if (cmd === "/usr/bin/security" || cmd.endsWith("/security")) return "keychain";
    return "unknown";
  }
  return "plain";
}

export function _processSecretInput(raw: string, field: string): string {
  const cleaned = raw.trim();
  if (cleaned !== raw) {
    log.info(`Trimmed whitespace from pasted ${field}.`);
  }
  const bytes = Buffer.byteLength(cleaned, "utf-8");
  if (bytes > 65_536) {
    throw new SecretTooLargeError(bytes);
  }
  return cleaned;
}

export function _formatOrphanCleanup(ctx: WizardCtx): string {
  const orphans = ctx.createdThisRun.filter((e) => !e.preExistedBeforeWizard);
  if (orphans.length === 0) return "";
  const lines: string[] = [
    "",
    "[wizard] Orphaned backend items created this run — delete manually if desired:",
  ];
  for (const o of orphans) {
    if (o.backend === "op") {
      lines.push(`  op item delete "${o.title}" --vault "${o.vaultName ?? ""}"`);
    } else if (o.backend === "keychain") {
      lines.push(
        `  security delete-generic-password -s cycling-coach -a "${o.title}" "${o.keychainPath ?? ""}"`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

export function _printOrphanCleanup(ctx: WizardCtx): void {
  const msg = _formatOrphanCleanup(ctx);
  if (msg.length > 0) {
    process.stderr.write(msg);
  }
}

export function _createSignalHandler(
  ctx: WizardCtx,
  signal: "SIGINT" | "SIGTERM",
): () => void {
  return () => {
    _printOrphanCleanup(ctx);
    const code = signal === "SIGINT" ? 130 : 143;
    process.exit(code);
  };
}

export function _assertTTY(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "cycling-coach setup requires an interactive TTY. See README 'Non-interactive setup' for hand-editing YAML directly.\n",
    );
    process.exit(2);
  }
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function handleCancel(value: unknown, ctx: WizardCtx): void {
  if (isCancel(value)) {
    _printOrphanCleanup(ctx);
    cancel("Setup cancelled.");
    process.exit(0);
  }
}

function getString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

function readFieldValue(
  obj: Record<string, unknown>,
  ...keys: string[]
): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur && typeof cur === "object" && k in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

async function runOpSignin(opPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(opPath, ["signin"], { stdio: "inherit", shell: false });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// ============================================================================
// WIZARD FLOW
// ============================================================================

export async function runSetup(): Promise<void> {
  _assertTTY();

  const ctx: WizardCtx = { createdThisRun: [] };
  const sigintHandler = _createSignalHandler(ctx, "SIGINT");
  const sigtermHandler = _createSignalHandler(ctx, "SIGTERM");
  process.once("SIGINT", sigintHandler);
  process.once("SIGTERM", sigtermHandler);

  try {
    await _runWizardCore(ctx);
  } catch (err) {
    await _guardedCleanup(ctx);
    cancel(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
  }
}

async function _runWizardCore(ctx: WizardCtx): Promise<void> {
  intro("Cycling Coach — Setup");

  const previous = readConfigYaml();
  const prevProvider = getString(previous, "llm", "provider");
  const prevModel = getString(previous, "llm", "model");
  const prevLlmKey = readFieldValue(previous, "llm", "api_key");
  const prevIntervalsKey = readFieldValue(previous, "intervals", "api_key");
  const prevIntervalsId = getString(previous, "intervals", "athlete_id");
  const prevTelegramToken = readFieldValue(previous, "telegram", "bot_token");

  // Provider
  const providerResp = await select({
    message: "LLM provider",
    options: PROVIDERS,
    initialValue: prevProvider ?? "anthropic",
  });
  handleCancel(providerResp, ctx);
  const provider = providerResp as string;

  // Model
  const sameProvider = provider === prevProvider;
  const knownModel = MODELS[provider]?.some((m) => m.value === prevModel);
  const initialModel = sameProvider && prevModel
    ? (knownModel ? prevModel : CUSTOM_MODEL_SENTINEL)
    : DEFAULT_MODELS[provider];
  const modelResp = await select({
    message: "Model",
    options: [
      ...(MODELS[provider] ?? []),
      { value: CUSTOM_MODEL_SENTINEL, label: "Other (type model name)" },
    ],
    initialValue: initialModel,
  });
  handleCancel(modelResp, ctx);
  let model = modelResp as string;

  if (model === CUSTOM_MODEL_SENTINEL) {
    const custom = await text({
      message: "Model name",
      defaultValue: sameProvider ? prevModel : undefined,
      placeholder: sameProvider ? prevModel : undefined,
      validate: (v) => (!v && !(sameProvider && prevModel) ? "Model name is required" : undefined),
    });
    handleCancel(custom, ctx);
    model = (typeof custom === "string" && custom) || prevModel || "";
  }

  // Codex OAuth — reuse existing profile unless the operator asks to re-login
  let freshCodexCreds: OAuthCredential | null = null;
  if (provider === "openai-codex") {
    const existing = loadProfile("openai-codex");
    let doLogin = true;
    if (existing) {
      const reuse = await confirm({
        message: "Existing Codex OAuth profile found. Re-login?",
        initialValue: false,
      });
      handleCancel(reuse, ctx);
      doLogin = Boolean(reuse);
    }
    if (doLogin) {
      log.info("Starting OAuth sign-in. ChatGPT Plus or higher required.");
      try {
        freshCodexCreds = await runCodexLogin();
        log.success("OpenAI Codex OAuth complete.");
      } catch (err) {
        cancel(`OAuth sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    }
  }

  // Detect backends + pick secret backend (D12 + D9)
  let backend = await _pickBackend(ctx);

  // Cache vault (D10 multi-vault fallback caches the chosen vault for the run)
  let chosenVault: string | undefined;
  let opAbsPath: string | undefined;
  let keychainPath: string | undefined;

  // Each secret gets processed: collect user input, branch on backend choice
  // vs previous backend, potentially apply D13 migration prompt, and write to
  // the chosen backend. The merged config is mutated in place.
  const merged: Record<string, unknown> = { ...previous };
  const llmConfig: Record<string, unknown> = { provider, model };
  if (provider === "openai-codex") {
    llmConfig.auth_profile = "openai-codex";
  }

  // llm.api_key (required unless Codex)
  if (provider !== "openai-codex") {
    const hasPrev = provider === prevProvider && isNonEmptySecret(prevLlmKey);
    const result = await _collectAndWriteSecret(ctx, {
      field: "llm.api_key",
      label: `${API_KEY_LABELS[provider]}`,
      required: !hasPrev,
      prevValue: provider === prevProvider ? prevLlmKey : undefined,
      backend,
      chosenVaultRef: { current: chosenVault },
      opAbsPathRef: { current: opAbsPath },
      keychainPathRef: { current: keychainPath },
    });
    chosenVault = result.chosenVault;
    opAbsPath = result.opAbsPath;
    keychainPath = result.keychainPath;
    backend = result.backend;
    if (result.yamlValue !== undefined) {
      llmConfig.api_key = result.yamlValue;
    }
  }
  merged.llm = llmConfig;

  // intervals.api_key (optional)
  let intervalsAthleteId = prevIntervalsId ?? "";
  {
    const hasPrev = isNonEmptySecret(prevIntervalsKey);
    const result = await _collectAndWriteSecret(ctx, {
      field: "intervals.api_key",
      label: "intervals.icu API key",
      required: false,
      prevValue: prevIntervalsKey,
      backend,
      chosenVaultRef: { current: chosenVault },
      opAbsPathRef: { current: opAbsPath },
      keychainPathRef: { current: keychainPath },
    });
    chosenVault = result.chosenVault;
    opAbsPath = result.opAbsPath;
    keychainPath = result.keychainPath;
    backend = result.backend;
    if (result.yamlValue !== undefined) {
      // Ask for athlete ID when the user typed a new key (reuse prev athlete id on keep).
      if (result.providedNewValue) {
        const athleteId = await text({
          message: "intervals.icu athlete ID",
          defaultValue: prevIntervalsId ?? "0",
          placeholder: prevIntervalsId ?? "0",
        });
        handleCancel(athleteId, ctx);
        intervalsAthleteId = (typeof athleteId === "string" && athleteId) || prevIntervalsId || "0";
      } else if (hasPrev) {
        intervalsAthleteId = prevIntervalsId ?? "0";
      }
      merged.intervals = {
        api_key: result.yamlValue,
        athlete_id: intervalsAthleteId || "0",
      };
    } else if (prevIntervalsId) {
      // User skipped the api_key prompt but a prior athlete_id exists (common
      // when api_key comes from INTERVALS_API_KEY env var and only athlete_id
      // is in YAML). Preserve it — don't silently wipe the section.
      merged.intervals = { athlete_id: prevIntervalsId };
    } else {
      delete merged.intervals;
    }
  }

  // telegram.bot_token (optional)
  {
    const result = await _collectAndWriteSecret(ctx, {
      field: "telegram.bot_token",
      label: "Telegram bot token",
      required: false,
      prevValue: prevTelegramToken,
      backend,
      chosenVaultRef: { current: chosenVault },
      opAbsPathRef: { current: opAbsPath },
      keychainPathRef: { current: keychainPath },
    });
    chosenVault = result.chosenVault;
    opAbsPath = result.opAbsPath;
    keychainPath = result.keychainPath;
    backend = result.backend;
    if (result.yamlValue !== undefined) {
      merged.telegram = { bot_token: result.yamlValue };
    } else {
      delete merged.telegram;
    }
  }

  // Confirm before writing when a prior config exists.
  if (existsSync(CONFIG_FILE)) {
    const ok = await confirm({
      message: `Update ${CONFIG_FILE}?`,
      initialValue: true,
    });
    handleCancel(ok, ctx);
    if (!ok) {
      log.info("No changes written.");
      return;
    }
  }

  const originalBytes = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE) : null;

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, toYaml(merged), { mode: 0o600 });

  if (freshCodexCreds) {
    try {
      saveProfile("openai-codex", freshCodexCreds);
    } catch (err) {
      if (originalBytes) {
        writeFileSync(CONFIG_FILE, originalBytes, { mode: 0o600 });
      } else {
        try { unlinkSync(CONFIG_FILE); } catch { /* best-effort */ }
      }
      cancel(`Failed to save OAuth profile: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  outro(`Config written to ${CONFIG_FILE}\n  Run \`cycling-coach\` to start.`);
}

function isNonEmptySecret(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (isSecretRef(value)) return true;
  return false;
}

async function _pickBackend(ctx: WizardCtx): Promise<BackendChoice> {
  while (true) {
    const avail: BackendAvailability = await detectBackends();
    const options: { value: string; label: string; hint?: string }[] = [
      { value: BACKEND_PLAIN, label: "Plain config.yaml" },
    ];
    if (avail.op.state === "ready") {
      options.push({
        value: BACKEND_OP,
        label: `1Password CLI (signed in as ${avail.op.signedInAs})`,
      });
    } else if (avail.op.state === "needs-signin") {
      options.push({
        value: BACKEND_OP_SIGNIN,
        label: "1Password CLI — sign in first",
      });
    } else {
      log.info(
        `1Password CLI unavailable (${describeOpState(avail.op)}); backend not offered.`,
      );
    }
    if (avail.keychain.available) {
      options.push({ value: BACKEND_KEYCHAIN, label: "macOS Keychain" });
    }

    const picked = await select({
      message: "Where to store secrets?",
      options,
      initialValue: BACKEND_PLAIN,
    });
    handleCancel(picked, ctx);

    if (picked === BACKEND_PLAIN) return "plain";
    if (picked === BACKEND_KEYCHAIN) return "keychain";
    if (picked === BACKEND_OP) return "op";
    if (picked === BACKEND_OP_SIGNIN) {
      if (avail.op.state !== "needs-signin") {
        continue; // state changed underneath; re-detect
      }
      const opPath = avail.op.absolutePath;
      log.info("Running `op signin` — complete the prompt in this terminal.");
      const ok = await runOpSignin(opPath);
      if (!ok) {
        log.error("`op signin` did not complete successfully. Pick another backend.");
        continue;
      }
      const reDetected = await detectBackends();
      if (reDetected.op.state === "ready") {
        return "op";
      }
      log.info(
        `1Password still not available (${describeOpState(reDetected.op)}). Pick another backend.`,
      );
      continue;
    }
    // Unreachable but keeps TS happy.
    return "plain";
  }
}

function describeOpState(state: OpState): string {
  if (state.state === "ready") return `signed in as ${state.signedInAs}`;
  if (state.state === "needs-signin") return "needs-signin";
  if (state.reason === "not-on-path") return "not installed";
  if (state.reason === "no-account") return "no account configured";
  return `other: ${state.detail ?? "unknown"}`;
}

// ============================================================================
// SECRET INTAKE + WRITE
// ============================================================================

type CollectArgs = {
  field: SecretFieldPath;
  label: string;
  required: boolean;
  prevValue: unknown;
  backend: BackendChoice;
  chosenVaultRef: { current: string | undefined };
  opAbsPathRef: { current: string | undefined };
  keychainPathRef: { current: string | undefined };
};

type CollectResult = {
  yamlValue: string | SecretRef | undefined;
  providedNewValue: boolean;
  chosenVault: string | undefined;
  opAbsPath: string | undefined;
  keychainPath: string | undefined;
  backend: BackendChoice;
};

async function _collectAndWriteSecret(
  ctx: WizardCtx,
  args: CollectArgs,
): Promise<CollectResult> {
  const { field, label, required, prevValue } = args;
  let backend = args.backend;
  const hasPrev = isNonEmptySecret(prevValue);
  const prevBackend = _detectPrevBackend(prevValue);

  const promptLabel = hasPrev
    ? `${label} (Enter to keep existing)`
    : required
      ? label
      : `${label} (Enter to skip)`;

  const entered = await password({
    message: promptLabel,
    validate: () => undefined,
  });
  handleCancel(entered, ctx);
  const raw = typeof entered === "string" ? entered : "";

  if (raw.length === 0) {
    // Enter-keep / Enter-skip branch.
    if (!hasPrev) {
      if (required) {
        cancel(`${label} is required.`);
        process.exit(1);
      }
      return {
        yamlValue: undefined,
        providedNewValue: false,
        chosenVault: args.chosenVaultRef.current,
        opAbsPath: args.opAbsPathRef.current,
        keychainPath: args.keychainPathRef.current,
        backend,
      };
    }

    // hasPrev === true. If backend matches prev, keep as-is.
    if (prevBackend === "unknown" || prevBackend === backend) {
      return {
        yamlValue: prevValue as string | SecretRef,
        providedNewValue: false,
        chosenVault: args.chosenVaultRef.current,
        opAbsPath: args.opAbsPathRef.current,
        keychainPath: args.keychainPathRef.current,
        backend,
      };
    }

    // D13 cross-backend keep-vs-paste prompt.
    const action = await select({
      message: `${label}: switch backend from ${prevBackend} to ${backend}?`,
      options: [
        { value: "paste", label: `Paste a new value to migrate to ${backend}` },
        { value: "keep", label: `Keep in ${prevBackend} (YAML unchanged)` },
      ],
      initialValue: "keep",
    });
    handleCancel(action, ctx);
    if (action === "keep") {
      return {
        yamlValue: prevValue as string | SecretRef,
        providedNewValue: false,
        chosenVault: args.chosenVaultRef.current,
        opAbsPath: args.opAbsPathRef.current,
        keychainPath: args.keychainPathRef.current,
        backend,
      };
    }

    // Paste: re-prompt with a required value.
    const second = await password({
      message: `${label} (paste new value)`,
      validate: (v) => (!v ? `${label} is required when migrating.` : undefined),
    });
    handleCancel(second, ctx);
    const cleanedSecond = _processSecretInput(
      typeof second === "string" ? second : "",
      field,
    );
    if (cleanedSecond.length === 0) {
      cancel(`${label} is required when migrating.`);
      process.exit(1);
    }
    return await _writeToBackend(ctx, args, backend, cleanedSecond);
  }

  // Non-empty input: trim + size cap, then write to chosen backend.
  const cleaned = _processSecretInput(raw, field);
  if (cleaned.length === 0) {
    if (required) {
      cancel(`${label} is required.`);
      process.exit(1);
    }
    if (hasPrev) {
      return {
        yamlValue: prevValue as string | SecretRef,
        providedNewValue: false,
        chosenVault: args.chosenVaultRef.current,
        opAbsPath: args.opAbsPathRef.current,
        keychainPath: args.keychainPathRef.current,
        backend,
      };
    }
    return {
      yamlValue: undefined,
      providedNewValue: false,
      chosenVault: args.chosenVaultRef.current,
      opAbsPath: args.opAbsPathRef.current,
      keychainPath: args.keychainPathRef.current,
      backend,
    };
  }

  return await _writeToBackend(ctx, args, backend, cleaned);
}

async function _writeToBackend(
  ctx: WizardCtx,
  args: CollectArgs,
  backend: BackendChoice,
  value: string,
): Promise<CollectResult> {
  const { field } = args;
  if (backend === "plain") {
    return {
      yamlValue: value,
      providedNewValue: true,
      chosenVault: args.chosenVaultRef.current,
      opAbsPath: args.opAbsPathRef.current,
      keychainPath: args.keychainPathRef.current,
      backend,
    };
  }

  if (backend === "op") {
    const opAbsPath = args.opAbsPathRef.current ?? (await discoverOpAbsPath());
    const title = FIELD_TITLES[field];
    const preExistingVault = await preCheckOpExistence(
      opAbsPath,
      title,
      args.chosenVaultRef.current,
    );
    const preExistedBeforeWizard = preExistingVault !== null;

    let resolvedVault: string;

    if (preExistingVault !== null) {
      // Prompt Update / Keep / Cancel (D10 re-run flow)
      const action = await select({
        message: `1Password item "${title}" already exists in vault "${preExistingVault}". Action?`,
        options: [
          { value: "update", label: "Update with new value" },
          { value: "keep", label: "Keep existing (no write)" },
          { value: "cancel", label: "Cancel setup" },
        ],
        initialValue: "update",
      });
      handleCancel(action, ctx);
      if (action === "cancel") {
        // Mirror the SIGINT/clack-cancel paths: print manual cleanup for any
        // items already created earlier in this run.
        _printOrphanCleanup(ctx);
        process.exit(0);
      }
      if (action === "keep") {
        resolvedVault = preExistingVault;
        ctx.createdThisRun.push({
          backend: "op",
          field,
          title,
          vaultName: resolvedVault,
          opAbsPath,
          preExistedBeforeWizard: true,
        });
        return {
          yamlValue: opSecretRef(title, opAbsPath, resolvedVault),
          providedNewValue: false,
          chosenVault: resolvedVault,
          opAbsPath,
          keychainPath: args.keychainPathRef.current,
          backend,
        };
      }
      await opItemUpdate(opAbsPath, title, value, preExistingVault);
      resolvedVault = preExistingVault;
    } else {
      resolvedVault = await createOpItem(
        ctx,
        opAbsPath,
        title,
        value,
        args.chosenVaultRef.current,
      );
    }

    ctx.createdThisRun.push({
      backend: "op",
      field,
      title,
      vaultName: resolvedVault,
      opAbsPath,
      preExistedBeforeWizard,
    });
    return {
      yamlValue: opSecretRef(title, opAbsPath, resolvedVault),
      providedNewValue: true,
      chosenVault: resolvedVault,
      opAbsPath,
      keychainPath: args.keychainPathRef.current,
      backend,
    };
  }

  // keychain
  const keychainPath = args.keychainPathRef.current ?? (await keychainLoginPath());
  const account = FIELD_KEYCHAIN_ACCOUNT[field];
  const preExisted = await keychainItemExists(account, keychainPath).catch(() => false);
  try {
    await keychainItemUpsert(account, value, keychainPath);
  } catch (err) {
    if (err instanceof KeychainUnsafeValueError) {
      cancel(err.message);
      process.exit(1);
    }
    throw err;
  }
  ctx.createdThisRun.push({
    backend: "keychain",
    field,
    title: account,
    keychainPath,
    preExistedBeforeWizard: preExisted,
  });
  return {
    yamlValue: keychainSecretRef(account, keychainPath),
    providedNewValue: true,
    chosenVault: args.chosenVaultRef.current,
    opAbsPath: args.opAbsPathRef.current,
    keychainPath,
    backend,
  };
}

async function preCheckOpExistence(
  opAbsPath: string,
  title: string,
  knownVault: string | undefined,
): Promise<string | null> {
  // Let opItemGet throws propagate. The NOT_AN_ITEM_RE branch inside opItemGet
  // is the only genuine not-exists signal; everything else (timeout, auth
  // failure, non-JSON stdout) is a real error that would otherwise silently
  // become "item doesn't exist" and cause a duplicate item to be created.
  const res = await opItemGet(opAbsPath, title, knownVault);
  return res.exists ? res.vaultName : null;
}

async function createOpItem(
  ctx: WizardCtx,
  opAbsPath: string,
  title: string,
  value: string,
  cachedVault: string | undefined,
): Promise<string> {
  try {
    const out = await opItemCreate(opAbsPath, title, value, cachedVault);
    return out.vaultName;
  } catch (err) {
    if (err instanceof OpVaultAmbiguousError) {
      const vaults = await opVaultList(opAbsPath);
      const picked = await select({
        message: "Multiple 1Password vaults — pick one:",
        options: vaults.map((v) => ({ value: v.name, label: v.name })),
      });
      handleCancel(picked, ctx);
      const chosen = picked as string;
      const retry = await opItemCreate(opAbsPath, title, value, chosen);
      return retry.vaultName;
    }
    throw err;
  }
}

async function discoverOpAbsPath(): Promise<string> {
  // Re-run detection to get the absolute op path; detectBackends caches
  // nothing, but this runs once per new-value secret write at most.
  const avail = await detectBackends();
  if (avail.op.state === "ready") return avail.op.absolutePath;
  if (avail.op.state === "needs-signin") return avail.op.absolutePath;
  throw new Error(
    `1Password backend became unavailable mid-wizard (${describeOpState(avail.op)}).`,
  );
}

// ============================================================================
// GUARDED CLEANUP (D11)
// ============================================================================

export async function _guardedCleanup(ctx: WizardCtx): Promise<void> {
  const orphans = ctx.createdThisRun.filter((e) => !e.preExistedBeforeWizard);
  if (orphans.length === 0) return;

  log.error(
    `Wizard failed after creating ${orphans.length} new backend item(s) that are not yet in config.yaml.`,
  );

  const doCleanup = await confirm({
    message: `Delete the ${orphans.length} orphan item(s) now?`,
    initialValue: false,
  });
  if (isCancel(doCleanup) || !doCleanup) {
    _printOrphanCleanup(ctx);
    return;
  }

  for (const o of orphans) {
    try {
      if (o.backend === "op" && o.opAbsPath && o.vaultName) {
        await opItemDelete(o.opAbsPath, o.title, o.vaultName);
        log.info(`Deleted 1Password item "${o.title}".`);
      } else if (o.backend === "keychain" && o.keychainPath) {
        await keychainItemDelete(o.title, o.keychainPath);
        log.info(`Deleted Keychain item "${o.title}".`);
      }
    } catch (err) {
      log.error(
        `Failed to delete ${o.backend} item "${o.title}": ${err instanceof Error ? err.message : String(err)}`,
      );
      // Continue best-effort — don't stop on the first failure.
    }
  }
}
