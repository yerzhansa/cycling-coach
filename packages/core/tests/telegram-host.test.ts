import { describe, expectTypeOf, it } from "vitest";
import type { CoachEngine } from "@enduragent/coach-contract";
import type { CreateTelegramChannelInput } from "../src/channels/telegram.js";
import type {
  TelegramHostCapabilities,
  TelegramReleaseCapabilities,
} from "../src/channels/telegram-host.js";

describe("TelegramHostCapabilities", () => {
  it("cannot become a second coaching-engine contract", () => {
    type DuplicatedEngineMethod = Extract<keyof TelegramHostCapabilities, keyof CoachEngine>;

    expectTypeOf<DuplicatedEngineMethod>().toEqualTypeOf<never>();
  });

  it("requires the complete canonical engine at the channel boundary", () => {
    expectTypeOf<CreateTelegramChannelInput["engine"]>().toEqualTypeOf<CoachEngine>();
  });

  it("keeps npm pairing presentation out of the reusable channel input", () => {
    type PairingPresentationLeak = Extract<keyof CreateTelegramChannelInput, "pairingCommandName">;
    type IsNever<T> = [T] extends [never] ? true : false;
    type Assert<T extends true> = T;
    type _NoPairingPresentation = Assert<IsNever<PairingPresentationLeak>>;

    expectTypeOf<PairingPresentationLeak>().toEqualTypeOf<never>();
    expectTypeOf<_NoPairingPresentation>().toEqualTypeOf<true>();
  });

  it("makes a Desktop-owned release structurally incapable of npm installation", () => {
    type DesktopRelease = Extract<
      TelegramReleaseCapabilities,
      { readonly updatePolicy: "managed-deploy" | "desktop-owned" }
    >;
    type Installer = Extract<keyof DesktopRelease, "install">;

    expectTypeOf<Installer>().toEqualTypeOf<never>();
  });
});
