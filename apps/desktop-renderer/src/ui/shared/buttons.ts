import { buttonVariants } from "../../components/ui/button.js";
import { cn } from "../../lib/utils.js";

export const BUTTON_SOLID_SM = cn(buttonVariants({ variant: "default", size: "sm" }));

export const BUTTON_OUTLINE_SM = cn(buttonVariants({ variant: "outline", size: "sm" }));

export const BUTTON_QUIET_SM = cn(buttonVariants({ variant: "ghost", size: "sm" }));

export const BUTTON_COMPACT_QUIET_SM = BUTTON_QUIET_SM;

export const BUTTON_DANGER_QUIET_SM = cn(buttonVariants({ variant: "destructive", size: "sm" }));

export const BUTTON_DANGER_SOLID_SM = cn(
  buttonVariants({ variant: "destructive-solid", size: "sm" }),
);

export const BUTTON_PRIMARY = cn(buttonVariants({ variant: "default", size: "lg" }));
