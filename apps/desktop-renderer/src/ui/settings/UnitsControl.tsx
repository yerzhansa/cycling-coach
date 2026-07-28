import type { UnitsPreference } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { useEnduragentStore } from "../../state/store.js";
import AppearanceStyles from "./AppearanceControl.module.css";

const OPTIONS: readonly { readonly value: UnitsPreference; readonly label: string }[] =
  Object.freeze([
    { value: "metric", label: "Metric" },
    { value: "imperial", label: "Imperial" },
  ]);

export function UnitsControl(): ReactElement {
  const units = useEnduragentStore((store) => store.settings.units);
  const port = useEnduragentStore((store) => store.settingsPorts?.units ?? null);
  const disabled = port === null || units.status === "loading" || units.status === "saving";

  return (
    <div className={AppearanceStyles.seg} role="group" aria-label="Display units">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={
            option.value === units.value
              ? `${AppearanceStyles.option} ${AppearanceStyles.on}`
              : AppearanceStyles.option
          }
          aria-pressed={option.value === units.value}
          disabled={disabled}
          onClick={() => {
            port?.set(option.value);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
