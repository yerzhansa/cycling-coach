export * from "./fit-decoder.js";
export * from "./fit-import.js";
export * from "./xml-file.js";
export * from "./ingest-version.js";

import { mapFitArtifact } from "@enduragent/kernel/ingest";
import type { CryptoPort } from "@enduragent/kernel/ports";
import type { FitDecoder } from "./fit-decoder.js";
import { parseXmlBytes } from "./xml-file.js";
import type { ArchivedRawArtifact, ReconstructedArtifact } from "./ingest-version.js";

export function createArchivedArtifactReconstructor(dependencies: {
  readonly decoder: FitDecoder;
  readonly crypto: CryptoPort;
}): (artifact: ArchivedRawArtifact) => Promise<ReconstructedArtifact> {
  return async (artifact) => {
    if (artifact.format === "fit") {
      const decoded = await dependencies.decoder.decode(artifact.bytes);
      return mapFitArtifact({
        crypto: dependencies.crypto,
        rawSha256: artifact.rawSha256,
        rawByteLength: artifact.bytes.byteLength,
        archivePath: artifact.archivePath,
        decoded,
      });
    }
    const report = parseXmlBytes(artifact.bytes, artifact.format);
    if (report.quarantine !== null) throw new Error(`archived XML rejected: ${report.quarantine.code}`);
    return null;
  };
}
