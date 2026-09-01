import {
  type ArchiveArtifact,
  type ArchiveManifestReader,
  type ArchivePresenceChecker,
  type AuthoredRow,
  type ExportCryptoPort,
  type ExportSource,
  type ImportSink,
  type RestoreTableResult,
  type TextCodec,
  PURE_AUTHORED_TABLES,
  MIXED_AUTHORED_TABLES,
} from "./ports.js";
import {
  encodeContainer,
  decodeContainer,
  EXPORT_FORMAT_VERSION,
  ExportFormatError,
} from "./container.js";

export const EXPORT_DOCUMENT_KIND = "enduragent-export" as const;

export const EXPORT_WARNING =
  "Warning: this file contains your full health and chat history. Anyone who can open it — and, if you set one, anyone who has the passphrase — can read everything in it. Store it somewhere private, and only share it over a channel you trust." as const;

export class ExportSchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportSchemaMismatchError";
  }
}

export interface BuildExportDeps {
  readonly source: ExportSource;
  readonly manifest: ArchiveManifestReader;
  readonly crypto: ExportCryptoPort;
  readonly codec: TextCodec;
}
export interface BuildExportResult {
  readonly container: Uint8Array;
  readonly warning: string;
  readonly encrypted: boolean;
  readonly tables: readonly { readonly table: string; readonly count: number }[];
  readonly artifactCount: number;
}

export interface ImportExportDeps {
  readonly sink: ImportSink;
  readonly presence: ArchivePresenceChecker;
  readonly crypto: ExportCryptoPort;
  readonly codec: TextCodec;
  readonly targetUserVersion: number;
}
export interface ManifestVerification {
  readonly total: number;
  readonly present: number;
  readonly missing: readonly ArchiveArtifact[];
}
export interface ImportResult {
  readonly restored: readonly RestoreTableResult[];
  readonly manifest: ManifestVerification;
}

const ALL_AUTHORED_TABLES = [...PURE_AUTHORED_TABLES, ...MIXED_AUTHORED_TABLES] as const;

const PARENT_FIRST_REVISION_COLUMNS: Readonly<Record<string, string>> = Object.freeze({
  plan_draft_revision: "revision",
  plan_revision: "revision_number",
  plan_creation_draft_revision: "revision_number",
});

function orderAuthoredRows(table: string, rows: readonly AuthoredRow[]): readonly AuthoredRow[] {
  const revisionColumn = PARENT_FIRST_REVISION_COLUMNS[table];
  if (revisionColumn === undefined) return rows;
  return [...rows].sort((left, right) => {
    const leftValue = left[revisionColumn];
    const rightValue = right[revisionColumn];
    const leftRevision = typeof leftValue === "number" ? leftValue : null;
    const rightRevision = typeof rightValue === "number" ? rightValue : null;
    if (leftRevision === null && rightRevision !== null) return 1;
    if (leftRevision !== null && rightRevision === null) return -1;
    if (leftRevision !== null && rightRevision !== null && leftRevision !== rightRevision) {
      return leftRevision - rightRevision;
    }
    const leftId = typeof left.id === "string" ? left.id : "";
    const rightId = typeof right.id === "string" ? right.id : "";
    return leftId.localeCompare(rightId);
  });
}

export async function buildExport(
  deps: BuildExportDeps,
  opts: { passphrase?: string },
): Promise<BuildExportResult> {
  const userVersion = await deps.source.readUserVersion();
  const authored: Record<string, readonly AuthoredRow[]> = {};
  for (const t of PURE_AUTHORED_TABLES) {
    authored[t] = orderAuthoredRows(
      t,
      await deps.source.readAuthoredTable(t, { manualOnly: false }),
    );
  }
  for (const t of MIXED_AUTHORED_TABLES) {
    authored[t] = orderAuthoredRows(
      t,
      await deps.source.readAuthoredTable(t, { manualOnly: true }),
    );
  }
  const artifacts = [...(await deps.manifest.listArtifacts())].sort((a, b) =>
    a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
  );
  const document = {
    kind: EXPORT_DOCUMENT_KIND,
    formatVersion: EXPORT_FORMAT_VERSION,
    store: { userVersion, authored },
    archiveManifest: artifacts,
  };
  const container = await encodeContainer(
    document,
    { codec: deps.codec, crypto: deps.crypto },
    { passphrase: opts.passphrase },
  );
  return {
    container,
    warning: EXPORT_WARNING,
    encrypted: Boolean(opts.passphrase),
    tables: ALL_AUTHORED_TABLES.map((t) => ({ table: t, count: authored[t].length })),
    artifactCount: artifacts.length,
  };
}

export async function importExport(
  deps: ImportExportDeps,
  opts: { container: Uint8Array; passphrase?: string },
): Promise<ImportResult> {
  const document = await decodeContainer(
    opts.container,
    { codec: deps.codec, crypto: deps.crypto },
    { passphrase: opts.passphrase },
  );
  if (document === null || typeof document !== "object") {
    throw new ExportFormatError("The export file is not a recognized enduragent export document.");
  }
  const doc = document as Record<string, unknown>;
  if (doc.kind !== EXPORT_DOCUMENT_KIND || doc.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new ExportFormatError("The export file is not a recognized enduragent export document.");
  }
  const store = doc.store;
  const archiveManifest = doc.archiveManifest;
  if (store === null || typeof store !== "object") {
    throw new ExportFormatError("The export file is not a recognized enduragent export document.");
  }
  const storeRecord = store as Record<string, unknown>;
  if (
    typeof storeRecord.authored !== "object" ||
    storeRecord.authored === null ||
    !Array.isArray(archiveManifest)
  ) {
    throw new ExportFormatError("The export file is not a recognized enduragent export document.");
  }
  const storeUserVersion = storeRecord.userVersion;
  const authored = storeRecord.authored as Record<string, readonly AuthoredRow[]>;
  if (
    typeof storeUserVersion !== "number" ||
    !Number.isSafeInteger(storeUserVersion) ||
    storeUserVersion < 0
  ) {
    throw new ExportFormatError("The export file is not a recognized enduragent export document.");
  }
  if (storeUserVersion > deps.targetUserVersion) {
    throw new ExportSchemaMismatchError(
      "This backup was created by a newer version of the app; update before restoring.",
    );
  }
  const restored: RestoreTableResult[] = [];
  for (const t of ALL_AUTHORED_TABLES) {
    const rows = authored[t] ?? [];
    restored.push(
      await deps.sink.restoreAuthoredTable(t, rows, {
        sourceUserVersion: storeUserVersion,
      }),
    );
  }
  const manifestArtifacts = archiveManifest as readonly ArchiveArtifact[];
  const missing: ArchiveArtifact[] = [];
  for (const art of manifestArtifacts) {
    if (!(await deps.presence.hasArtifact(art.address))) missing.push(art);
  }
  return {
    restored,
    manifest: {
      total: manifestArtifacts.length,
      present: manifestArtifacts.length - missing.length,
      missing,
    },
  };
}
