import { chronoBridge, CHRONO_BRIDGE_PARAMS } from "./chrono-bridge.js";
import { pulseWeave, PULSE_WEAVE_PARAMS } from "./pulse-weave.js";
import { summitGuard, SUMMIT_GUARD_PARAMS } from "./summit-guard.js";
import type { CanonicalRepairStream, RepairChainResult } from "./types.js";

export const REPAIR_CHAIN_SLOTS = Object.freeze([
  Object.freeze({ slot: "010", fixer: "chronoBridge" }),
  Object.freeze({ slot: "020", fixer: null, reserved: "reserved-w5c-a" }),
  Object.freeze({ slot: "030", fixer: "summitGuard" }),
  Object.freeze({ slot: "040", fixer: null, reserved: "reserved-w5c-b" }),
  Object.freeze({ slot: "050", fixer: "pulseWeave" }),
  Object.freeze({ slot: "060", fixer: null, reserved: "reserved-w5c-c" }),
] as const);

export function runRepairChain(stream: CanonicalRepairStream): RepairChainResult {
  const chrono = chronoBridge(stream);
  const summit = summitGuard(chrono.stream);
  const pulse = pulseWeave(summit.stream);
  return {
    stream: pulse.stream,
    logs: [
      { fixer: "chronoBridge", params: CHRONO_BRIDGE_PARAMS, changes: chrono.changes },
      { fixer: "summitGuard", params: SUMMIT_GUARD_PARAMS, changes: summit.changes },
      { fixer: "pulseWeave", params: PULSE_WEAVE_PARAMS, changes: pulse.changes },
    ],
  };
}
