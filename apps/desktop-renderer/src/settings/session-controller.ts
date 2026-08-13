import {
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  type CoachClient,
} from "@enduragent/coach-client";
import type { ConfigureRuntimeRpcParams, RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../coach-client.js";

export const SESSION_SETTING_FIELDS = [
  "timezone",
  "dailyResetHour",
  "idleMinutes",
  "resetArchiveRetentionDays",
  "historyTokenBudgetRatio",
] as const;

export type SessionSettingField = (typeof SESSION_SETTING_FIELDS)[number];

export type SessionSettingsValidationErrors = Readonly<
  Partial<Record<SessionSettingField, string>>
>;

export interface SessionSettingsDraft {
  readonly timezone: string;
  readonly dailyResetHour: string;
  readonly idleMinutes: string;
  readonly resetArchiveRetentionDays: string;
  readonly historyTokenBudgetRatio: string;
}

export interface SessionSettingsFormState {
  readonly effective: RuntimeConfigSnapshot["session"];
  readonly draft: SessionSettingsDraft;
  readonly dirtyFields: ReadonlySet<SessionSettingField>;
  readonly validationErrors: SessionSettingsValidationErrors;
}

export type SessionSettingsState =
  | { readonly status: "closed" }
  | { readonly status: "loading" }
  | ({ readonly status: "ready" | "refreshing" | "saving" | "saved" } & SessionSettingsFormState)
  | {
      readonly status: "error";
      readonly kind: "load";
      readonly reason: "runtime-unavailable";
    }
  | ({
      readonly status: "error";
      readonly kind: "save";
      readonly reason:
        | "request-failed"
        | "not-applied"
        | "runtime-unavailable"
        | "timezone-not-pinned";
    } & SessionSettingsFormState);

class SessionTimezonePinFailedError extends Error {}

export interface SessionSettingsView {
  bind(handlers: {
    readonly onRetry: () => void;
    readonly onChange: (field: SessionSettingField, value: string) => void;
    readonly onSave: () => void;
  }): void;
  render(state: Exclude<SessionSettingsState, { readonly status: "closed" }>): void;
  dispose(): void;
}

export interface SessionSettingsController {
  activate(): Promise<void>;
  close(): void;
  state(): SessionSettingsState;
  dispose(): void;
}

function systemTimezone(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timezone.length > 0 ? timezone : "UTC";
}

export function percentTextForRatio(ratio: number): string {
  const percent = ratio * 100;
  for (let precision = 1; precision <= 17; precision += 1) {
    const candidate = String(Number(percent.toPrecision(precision)));
    if (Number(candidate) / 100 === ratio) return candidate;
  }
  return String(percent);
}

function effectiveTimezone(value: string): string {
  return value.length === 0 ? systemTimezone() : value;
}

function draftFrom(effective: RuntimeConfigSnapshot["session"]): SessionSettingsDraft {
  return {
    timezone: effectiveTimezone(effective.timezone),
    dailyResetHour: String(effective.dailyResetHour),
    idleMinutes: String(effective.idleMinutes),
    resetArchiveRetentionDays: String(effective.resetArchiveRetentionDays),
    historyTokenBudgetRatio: percentTextForRatio(effective.historyTokenBudgetRatio),
  };
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });
}

function validTimezone(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function parseSafeNonnegativeInteger(value: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseHistoryRatio(value: string): number | null {
  if (value.length === 0 || value.trim() !== value) return null;
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return null;
  const ratio = percent / 100;
  return Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : null;
}

function validationErrors(draft: SessionSettingsDraft): SessionSettingsValidationErrors {
  const errors: Partial<Record<SessionSettingField, string>> = {};
  if (!validTimezone(draft.timezone)) {
    errors.timezone = "Enter a valid IANA timezone, such as Europe/London.";
  }
  const dailyResetHour = parseSafeNonnegativeInteger(draft.dailyResetHour);
  if (dailyResetHour === null || dailyResetHour > 23) {
    errors.dailyResetHour = "Enter a whole hour from 0 to 23.";
  }
  if (parseSafeNonnegativeInteger(draft.idleMinutes) === null) {
    errors.idleMinutes = "Enter a safe whole number of minutes, 0 or more.";
  }
  if (parseSafeNonnegativeInteger(draft.resetArchiveRetentionDays) === null) {
    errors.resetArchiveRetentionDays = "Enter a safe whole number of days, 0 or more.";
  }
  if (parseHistoryRatio(draft.historyTokenBudgetRatio) === null) {
    errors.historyTokenBudgetRatio = "Enter a history budget above 0% and no more than 100%.";
  }
  return errors;
}

function fieldValue(
  field: SessionSettingField,
  draft: SessionSettingsDraft,
): string | number | null {
  if (field === "timezone") return validTimezone(draft.timezone) ? draft.timezone : null;
  if (field === "historyTokenBudgetRatio") {
    return parseHistoryRatio(draft.historyTokenBudgetRatio);
  }
  return parseSafeNonnegativeInteger(draft[field]);
}

function effectiveValue(
  field: SessionSettingField,
  effective: RuntimeConfigSnapshot["session"],
): string | number {
  if (field === "timezone") return effectiveTimezone(effective.timezone);
  return effective[field];
}

function isManaged(
  field: SessionSettingField,
  effective: RuntimeConfigSnapshot["session"],
): boolean {
  return effective.managedByEnvironment[field];
}

function dirtyFields(
  effective: RuntimeConfigSnapshot["session"],
  draft: SessionSettingsDraft,
): ReadonlySet<SessionSettingField> {
  return new Set(
    SESSION_SETTING_FIELDS.filter((field) => {
      if (isManaged(field, effective)) return false;
      if (
        field === "historyTokenBudgetRatio" &&
        draft.historyTokenBudgetRatio === percentTextForRatio(effective.historyTokenBudgetRatio)
      ) {
        return false;
      }
      const value = fieldValue(field, draft);
      return value !== null && value !== effectiveValue(field, effective);
    }),
  );
}

function formState(
  effective: RuntimeConfigSnapshot["session"],
  draft: SessionSettingsDraft,
): SessionSettingsFormState {
  const errors = { ...validationErrors(draft) };
  for (const field of SESSION_SETTING_FIELDS) {
    if (isManaged(field, effective)) delete errors[field];
  }
  return {
    effective,
    draft,
    dirtyFields: dirtyFields(effective, draft),
    validationErrors: errors,
  };
}

function editableState(state: SessionSettingsState): SessionSettingsFormState | null {
  if (
    state.status === "ready" ||
    state.status === "refreshing" ||
    state.status === "saving" ||
    state.status === "saved" ||
    (state.status === "error" && state.kind === "save")
  ) {
    return state;
  }
  return null;
}

function reconcileDraft(
  previous: SessionSettingsFormState | null,
  effective: RuntimeConfigSnapshot["session"],
): SessionSettingsDraft {
  const authoritative = draftFrom(effective);
  if (previous === null) return authoritative;
  const next = { ...authoritative };
  for (const field of SESSION_SETTING_FIELDS) {
    if (!isManaged(field, effective) && previous.dirtyFields.has(field)) {
      next[field] = previous.draft[field];
    }
  }
  return next;
}

function saveErrorReason(
  error: unknown,
): "request-failed" | "not-applied" | "timezone-not-pinned" {
  if (error instanceof SessionTimezonePinFailedError) return "timezone-not-pinned";
  if (error instanceof CoachClientProtocolError) return "not-applied";
  return "request-failed";
}

function buildSessionPatch(
  form: SessionSettingsFormState,
): NonNullable<ConfigureRuntimeRpcParams["session"]> {
  const patch: Partial<Record<SessionSettingField, string | number>> = {};
  for (const field of form.dirtyFields) {
    const value = fieldValue(field, form.draft);
    if (value !== null) patch[field] = value;
  }
  return patch as NonNullable<ConfigureRuntimeRpcParams["session"]>;
}

export function createSessionSettingsController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: SessionSettingsView;
  readonly beginMutation: () => (() => void) | null;
  readonly pinTimezone: () => Promise<boolean>;
}): SessionSettingsController {
  let currentState: SessionSettingsState = { status: "closed" };
  let generation = 0;
  let disposed = false;
  let operation: Promise<void> | undefined;
  let reconnectRequired = false;
  let failedClient: CoachClient | undefined;

  const render = (state: Exclude<SessionSettingsState, { readonly status: "closed" }>): void => {
    currentState = state;
    input.view.render(state);
  };

  const clientForOperation = async (): Promise<CoachClient> => {
    if (!reconnectRequired) return input.clients.getClient();
    const current = await input.clients.getClient();
    const client =
      failedClient !== undefined && current === failedClient
        ? await input.clients.reconnect()
        : current;
    reconnectRequired = false;
    failedClient = undefined;
    return client;
  };

  const noteFailure = (error: unknown, client: CoachClient | undefined): void => {
    if (error instanceof CoachClientDisconnectedError) {
      reconnectRequired = true;
      failedClient = client;
    }
  };

  const startLoad = (preserveDraft: boolean): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    const previous = preserveDraft ? editableState(currentState) : null;
    const operationGeneration = ++generation;
    if (previous === null) render({ status: "loading" });
    else render({ ...previous, status: "refreshing" });
    let activeClient: CoachClient | undefined;
    const pending = Promise.resolve()
      .then(async () => {
        activeClient = await clientForOperation();
        return activeClient.call("getRuntimeConfig", {});
      })
      .then(
        (snapshot) => {
          if (disposed || generation !== operationGeneration) return;
          const draft = reconcileDraft(previous, snapshot.session);
          render({ status: "ready", ...formState(snapshot.session, draft) });
        },
        (error: unknown) => {
          noteFailure(error, activeClient);
          if (disposed || generation !== operationGeneration) return;
          if (previous === null) {
            render({ status: "error", kind: "load", reason: "runtime-unavailable" });
          } else {
            render({
              ...previous,
              status: "error",
              kind: "save",
              reason: "runtime-unavailable",
            });
          }
        },
      )
      .finally(() => {
        if (operation === pending) operation = undefined;
      });
    operation = pending;
    return pending;
  };

  const change = (field: SessionSettingField, value: string): void => {
    if (disposed || currentState.status === "saving" || currentState.status === "refreshing")
      return;
    const editable = editableState(currentState);
    if (editable === null || isManaged(field, editable.effective)) return;
    const draft = { ...editable.draft, [field]: value };
    render({ status: "ready", ...formState(editable.effective, draft) });
  };

  const save = (): Promise<void> => {
    if (disposed || operation !== undefined) return operation ?? Promise.resolve();
    const editable = editableState(currentState);
    if (
      editable === null ||
      editable.dirtyFields.size === 0 ||
      Object.keys(editable.validationErrors).length > 0
    ) {
      return Promise.resolve();
    }
    const releaseMutation = input.beginMutation();
    if (releaseMutation === null) return Promise.resolve();
    const operationGeneration = ++generation;
    const patch = buildSessionPatch(editable);
    render({ ...editable, status: "saving" });
    let activeClient: CoachClient | undefined;
    const pending = Promise.resolve()
      .then(async () => {
        activeClient = await clientForOperation();
        const result = await activeClient.call("configureRuntime", { session: patch });
        if (result.status !== "applied" || result.applied.session !== true) {
          throw new CoachClientProtocolError();
        }
        const snapshot = await activeClient.call("getRuntimeConfig", {});
        if (editable.dirtyFields.has("timezone")) {
          let pinned: boolean;
          try {
            pinned = await input.pinTimezone();
          } catch {
            pinned = false;
          }
          if (pinned !== true) throw new SessionTimezonePinFailedError();
        }
        return snapshot;
      })
      .then(
        (snapshot) => {
          if (disposed || generation !== operationGeneration) return;
          render({
            status: "saved",
            ...formState(snapshot.session, draftFrom(snapshot.session)),
          });
        },
        (error: unknown) => {
          noteFailure(error, activeClient);
          if (disposed || generation !== operationGeneration) return;
          render({
            ...editable,
            status: "error",
            kind: "save",
            reason: saveErrorReason(error),
          });
        },
      )
      .finally(() => {
        releaseMutation();
        if (operation === pending) operation = undefined;
      });
    operation = pending;
    return pending;
  };

  input.view.bind({
    onRetry: () => void startLoad(currentState.status === "error" && currentState.kind === "save"),
    onChange: change,
    onSave: () => void save(),
  });

  return {
    activate() {
      if (disposed) return Promise.resolve();
      if (currentState.status !== "closed") return operation ?? Promise.resolve();
      return startLoad(false);
    },
    close() {
      if (disposed) return;
      ++generation;
      operation = undefined;
      currentState = { status: "closed" };
    },
    state: () => currentState,
    dispose() {
      if (disposed) return;
      disposed = true;
      ++generation;
      operation = undefined;
      currentState = { status: "closed" };
      input.view.dispose();
    },
  };
}
