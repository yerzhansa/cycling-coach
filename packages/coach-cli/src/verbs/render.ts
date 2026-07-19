import {
  CoachRpcNotificationEnvelopeSchema,
  JsonRpcResponseEnvelopeSchema,
  serializeCoachRpcEnvelope,
  type CoachRpcNotificationEnvelope,
  type JsonRpcResponseEnvelope,
} from "@enduragent/coach-contract";
import type { CoachClientTerminalEnvelope } from "@enduragent/coach-client";
import type { CoachCliOutputMode } from "../args.js";
import type { CoachCliTerminal } from "../repl.js";
import type { CoachVerbMethodName } from "./types.js";

export interface CoachVerbRenderer {
  readonly onNotificationEnvelope: (envelope: CoachRpcNotificationEnvelope) => void;
  readonly onTerminalEnvelope: (envelope: CoachClientTerminalEnvelope) => void;
  readonly observedTerminal: () => CoachClientTerminalEnvelope | undefined;
  renderSuccess(method: CoachVerbMethodName, envelope: JsonRpcResponseEnvelope): void;
}

export function createCoachVerbRenderer(
  outputMode: CoachCliOutputMode,
  terminal: Pick<CoachCliTerminal, "stdout">,
): CoachVerbRenderer {
  let observedTerminal: CoachClientTerminalEnvelope | undefined;
  return {
    onNotificationEnvelope(envelope) {
      if (outputMode !== "stream-json") return;
      const parsed = CoachRpcNotificationEnvelopeSchema.parse(envelope);
      terminal.stdout.write(`${serializeCoachRpcEnvelope(parsed)}\n`);
    },
    onTerminalEnvelope(envelope) {
      const parsed = JsonRpcResponseEnvelopeSchema.parse(envelope);
      if (parsed.id === null) throw new TypeError("unexpected protocol terminal");
      observedTerminal = envelope;
      if (outputMode === "stream-json") {
        terminal.stdout.write(`${serializeCoachRpcEnvelope(parsed)}\n`);
      }
    },
    observedTerminal: () => observedTerminal,
    renderSuccess(method, envelope) {
      if (!("result" in envelope)) throw new TypeError("expected success terminal");
      if (outputMode === "stream-json") return;
      if (outputMode === "json") {
        terminal.stdout.write(`${JSON.stringify(envelope.result)}\n`);
        return;
      }
      if (method === "chat") {
        const result = envelope.result as { readonly text: string };
        terminal.stdout.write(`${result.text}\n`);
        return;
      }
      if (method === "importFiles") {
        const result = envelope.result as {
          readonly files: {
            readonly total: number;
            readonly imported: number;
            readonly quarantined: number;
          };
        };
        terminal.stdout.write(
          `Imported ${result.files.imported} of ${result.files.total} files (${result.files.quarantined} quarantined).\n`,
        );
        return;
      }
      if (method === "sync") {
        const result = envelope.result as { readonly published: boolean };
        terminal.stdout.write(
          result.published
            ? "Training data refreshed.\n"
            : "Training data checked; no new snapshot was published.\n",
        );
        return;
      }
      terminal.stdout.write(`${JSON.stringify(envelope.result, null, 2)}\n`);
    },
  };
}
