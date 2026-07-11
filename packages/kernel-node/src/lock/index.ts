export {
  acquireWriteLock,
  WriteLockContentionError,
  LOCKFILE_NAME,
  PORT_FILE_NAME,
} from "./acquire.js";
export type {
  AcquireWriteLockOptions,
  AcquireWriteLockResult,
  WriteLockHandle,
  PeerHealthyOutcome,
} from "./acquire.js";
export type { LockfileBody } from "./lockfile-body.js";
export { readLockfile } from "./lockfile-body.js";
export type { HealthzVerdict, HealthzProbe } from "./healthz-probe.js";
export { classifyHealthzResponse, HEALTHZ_SERVICE_MARKER } from "./healthz-probe.js";
