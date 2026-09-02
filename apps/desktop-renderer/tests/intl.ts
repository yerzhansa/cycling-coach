import { vi } from "vitest";

export function pinDefaultLocale(locale: "en-GB" | "en-US", timeZone = "UTC"): void {
  const NativeDateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function DateTimeFormat(locales, options) {
    return new NativeDateTimeFormat(locales ?? locale, {
      ...options,
      timeZone: options?.timeZone ?? timeZone,
    });
  });
}
