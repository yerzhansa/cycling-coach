export type CoachCliInvocation =
  | { readonly kind: "repl" }
  | { readonly kind: "version" }
  | { readonly kind: "serve" }
  | {
      readonly kind: "usage";
      readonly message: "Usage: enduragent [version|serve]";
    };

export function parseCoachCliInvocation(argv: readonly string[]): CoachCliInvocation {
  if (argv.length === 0) return { kind: "repl" };
  if (argv.length === 1 && (argv[0] === "version" || argv[0] === "--version")) {
    return { kind: "version" };
  }
  if (argv.length === 1 && argv[0] === "serve") return { kind: "serve" };
  return { kind: "usage", message: "Usage: enduragent [version|serve]" };
}
