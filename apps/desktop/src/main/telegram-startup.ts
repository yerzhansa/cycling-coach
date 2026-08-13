import type {
  DesktopTelegramMutationResult,
  TelegramControlCoordinator,
} from "./telegram-control.js";
import type { DesktopTelegramPowerLifecycle } from "./telegram-power.js";

export async function startDesktopTelegram(input: {
  readonly supervision: "app-supervised" | "attached";
  readonly coordinator: Pick<TelegramControlCoordinator, "reconcile">;
  readonly power: Pick<DesktopTelegramPowerLifecycle, "start">;
}): Promise<DesktopTelegramMutationResult | undefined> {
  let reconciliation: DesktopTelegramMutationResult | undefined;
  if (input.supervision === "app-supervised") {
    reconciliation = await input.coordinator.reconcile();
  }
  await input.power.start();
  return reconciliation;
}
