import { chronoBridge, CHRONO_BRIDGE_PARAMS } from "./chrono-bridge.js";
import { pulseWeave, PULSE_WEAVE_PARAMS } from "./pulse-weave.js";
import { summitGuard, SUMMIT_GUARD_PARAMS } from "./summit-guard.js";
import {
  DEFAULT_REPAIR_FIXER_SETTINGS,
  cloneValidatedRepairStream,
  normalizeRepairFixerSettings,
  type CanonicalRepairStream,
  type RepairChainResult,
  type RepairFixerSettings,
  type RepairInvocationLog,
} from "./types.js";

export const REPAIR_CHAIN_SLOTS = Object.freeze([
  Object.freeze({ slot: "010", fixer: "chronoBridge" }),
  Object.freeze({ slot: "020", fixer: null, reserved: "reserved-w5c-a" }),
  Object.freeze({ slot: "030", fixer: "summitGuard" }),
  Object.freeze({ slot: "040", fixer: null, reserved: "reserved-w5c-b" }),
  Object.freeze({ slot: "050", fixer: "pulseWeave" }),
  Object.freeze({ slot: "060", fixer: null, reserved: "reserved-w5c-c" }),
] as const);

export function runRepairChain(
  stream: CanonicalRepairStream,
  settings: RepairFixerSettings = DEFAULT_REPAIR_FIXER_SETTINGS,
): RepairChainResult {
  const effective = normalizeRepairFixerSettings(settings);
  let current = cloneValidatedRepairStream(stream);
  const logs: RepairInvocationLog[] = [];
  if (effective.chronoBridge) {
    const result = chronoBridge(current);
    current = result.stream;
    logs.push({ fixer: "chronoBridge", params: CHRONO_BRIDGE_PARAMS, changes: result.changes });
  }
  if (effective.summitGuard) {
    const result = summitGuard(current);
    current = result.stream;
    logs.push({ fixer: "summitGuard", params: SUMMIT_GUARD_PARAMS, changes: result.changes });
  }
  if (effective.pulseWeave) {
    const result = pulseWeave(current);
    current = result.stream;
    logs.push({ fixer: "pulseWeave", params: PULSE_WEAVE_PARAMS, changes: result.changes });
  }
  return { stream: current, logs };
}
