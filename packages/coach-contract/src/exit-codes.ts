/**
 * Exit-code contract for a future CLI/daemon surface. The currently shipped
 * binaries do not consume these constants and their existing exit behavior is
 * unchanged.
 */

/** The command completed successfully. */
export const EXIT_SUCCESS = 0;
/** The agent failed while handling the request. */
export const EXIT_AGENT_ERROR = 1;
/** The command was invoked with invalid arguments or usage. */
export const EXIT_USAGE = 2;
/** The daemon is unreachable or contended. */
export const EXIT_DAEMON_UNAVAILABLE = 3;
/** The installation is not configured. */
export const EXIT_NOT_CONFIGURED = 4;
/** Client and engine disagree on PROTOCOL_VERSION. */
export const EXIT_VERSION_MISMATCH = 5;

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;
