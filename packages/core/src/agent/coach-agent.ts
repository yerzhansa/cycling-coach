import {
  createCoachEngine as createCanonicalCoachEngine,
  type ChatStorePort,
  type ModelTransportDecorator,
} from "@enduragent/engine";
import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";
import type { AthleteDataReader, PlatformCalendarMutations } from "../athlete-data.js";
import type { Config } from "../config.js";
import type { Memory } from "../memory/store.js";
import type { Sport } from "../sport.js";
import { ConfirmationGate } from "./confirmation-gate.js";
import { createEngineHostAdapter } from "./engine-host-adapter.js";
import { legacyStateReader } from "./legacy-athlete-state-reader.js";

export interface LegacyAgentOverrides {
  readonly athleteData?: AthleteDataReader;
  readonly calendarMutations?: PlatformCalendarMutations;
  readonly modelTransportDecorator?: ModelTransportDecorator;
  readonly onToolsAssembled?: (names: readonly string[]) => void;
}

export class CoachAgent {
  private readonly engine;
  private readonly memory: Memory;
  private readonly chatStore: ChatStorePort;
  readonly confirmations = new ConfirmationGate();

  constructor(sport: Sport, config: Config, overrides: LegacyAgentOverrides = {}) {
    const adapted = createEngineHostAdapter({
      config,
      stateReader: legacyStateReader,
      overrides: { ...overrides, confirmations: this.confirmations },
    });
    this.memory = adapted.memory;
    this.chatStore = adapted.ports.chatStore;
    this.engine = createCanonicalCoachEngine({ sport, ports: adapted.ports });
  }

  chat(
    chatId: string,
    userMessage: string,
    turn?: { resolvedCs?: ResolvedCs | null },
  ): Promise<string> {
    return this.engine.chat({
      chatId,
      message: userMessage,
      ...(turn === undefined ? {} : { turn }),
    }).then((response) => response.text);
  }

  hasSession(chatId: string): boolean {
    return this.chatStore.hasSession(chatId);
  }

  resetSession(chatId: string): Promise<{ memoryFlushed: boolean }> {
    return this.engine.resetSession({ chatId });
  }

  getMemory(): Memory {
    return this.memory;
  }
}
