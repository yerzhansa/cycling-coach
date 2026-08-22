import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const mergeTailwindClasses = extendTailwindMerge({
  extend: {
    theme: {
      radius: ["chip", "ctl", "card"],
      shadow: ["elev-1", "elev-2", "elev-3", "elev-4"],
      spacing: ["ctl", "ctl-sm", "ctl-lg", "ctl-px", "ctl-px-sm", "ctl-px-lg", "inset", "row"],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return mergeTailwindClasses(clsx(inputs));
}
