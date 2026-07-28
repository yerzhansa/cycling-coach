const listeners = new Set<() => void>();
let prefersDark = false;

export function installMatchMedia(): void {
  prefersDark = false;
  listeners.clear();
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      media: query,
      get matches() {
        return query.includes("dark") && prefersDark;
      },
      addEventListener(_type: string, listener: () => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: string, listener: () => void) {
        listeners.delete(listener);
      },
    }),
  });
}

export function setPrefersDark(value: boolean): void {
  prefersDark = value;
  for (const listener of [...listeners]) listener();
}
