// Bump on any breaking change to this package's schemas, interface shape, or
// framing semantics. Clients and the engine compare PROTOCOL_VERSION on
// connect; unequal values refuse with EXIT_VERSION_MISMATCH.
export const PROTOCOL_VERSION = 1;
