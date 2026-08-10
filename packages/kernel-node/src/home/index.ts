export { ATHLETE_HOME_ENV, expandTilde, resolveAthleteHome } from "./resolve-athlete-home.js";
export type { AthleteHome } from "./resolve-athlete-home.js";
export { prepareAthleteHome } from "./prepare-athlete-home.js";
export type { PrepareAthleteHomeOptions } from "./prepare-athlete-home.js";
export {
  WindowsAthleteHomePolicyError,
  ensureWindowsPrivateDirectory,
  prepareWindowsAthleteHome,
} from "./windows-home-policy.js";
export type { WindowsAthleteHomePolicyStage } from "./windows-home-policy.js";

export {
  FTP_HISTORY_SCHEMA_VERSION,
  FtpHistoryJsonSchema,
  FtpHistoryPointSchema,
} from "./ftp-history-schema.js";
export type { FtpHistoryJson, FtpHistoryPoint } from "./ftp-history-schema.js";

export {
  LEGACY_DATA_SUBDIR,
  FTP_HISTORY_FILENAME,
  epochSecondsFromDate,
  seedFtpHistory,
} from "./anchor-seeder.js";
export type {
  AnchorSeedRow,
  AnchorSeederStore,
  FtpSeedSource,
  FtpSeedReport,
  SeedFtpHistoryOptions,
} from "./anchor-seeder.js";

export { createAuthoredIdentity } from "../store/authored-identity.js";
export type { AuthoredIdentity, AuthoredIdentityDependencies } from "../store/authored-identity.js";
