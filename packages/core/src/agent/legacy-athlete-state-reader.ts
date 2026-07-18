import type { AthleteStateReaderPort } from "@enduragent/engine";

export class LegacyAthleteStateUnavailableError extends Error {}

export const legacyStateReader: AthleteStateReaderPort = {
  getAthleteState: () =>
    Promise.reject(new LegacyAthleteStateUnavailableError("The legacy positional facade exposes no persisted athlete-state reader.")),
};
