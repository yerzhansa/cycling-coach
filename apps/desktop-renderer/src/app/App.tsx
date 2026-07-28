import { useEffect, type ReactElement } from "react";
import type { LegacyHosts } from "../legacy-boot.js";
import { useEnduragentStore } from "../state/store.js";
import { DARK_MEDIA_QUERY } from "../theme/applyPalette.js";
import { Shell } from "./Shell.js";

export function App(props: {
  readonly onHostsReady: (hosts: LegacyHosts) => void;
}): ReactElement {
  const appearance = useEnduragentStore((state) => state.appearance);
  const refreshTheme = useEnduragentStore((state) => state.refreshTheme);

  useEffect(() => {
    if (appearance !== "system" || typeof matchMedia !== "function") return;
    const query = matchMedia(DARK_MEDIA_QUERY);
    const onChange = (): void => {
      refreshTheme();
    };
    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  }, [appearance, refreshTheme]);

  return <Shell onHostsReady={props.onHostsReady} />;
}
