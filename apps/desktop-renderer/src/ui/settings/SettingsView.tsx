import { useEffect, type ReactElement } from "react";
import { settingsMutationActive } from "../../state/settings-slice.js";
import { useEnduragentStore } from "../../state/store.js";
import { Page } from "../shared/Page.js";
import { ApplicationSection } from "./ApplicationSection.js";
import { CoachSection } from "./CoachSection.js";
import { ConversationSection } from "./ConversationSection.js";
import { CredentialsSection } from "./CredentialsSection.js";
import { PreferencesSection } from "./PreferencesSection.js";
import { SpendSection } from "./SpendSection.js";
import { TrainingAccountSection } from "./TrainingAccountSection.js";

export function SettingsView(): ReactElement {
  const ports = useEnduragentStore((store) => store.settingsPorts);
  const busy = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const closeSettingsPanes = useEnduragentStore((store) => store.closeSettingsPanes);

  useEffect(() => {
    if (ports === null) return;
    ports.panes.activate();
    return () => {
      closeSettingsPanes();
    };
  }, [closeSettingsPanes, ports]);

  return (
    <Page title="Settings" subtitle={busy ? "Saving…" : undefined} busy={busy}>
      <CoachSection />
      <CredentialsSection />
      <TrainingAccountSection />
      <ConversationSection />
      <SpendSection />
      <PreferencesSection />
      <ApplicationSection />
    </Page>
  );
}
