export type CoachCliInvocation =
  | { readonly kind: "repl" }
  | { readonly kind: "version" }
  | {
      readonly kind: "usage";
      readonly message: "Usage: enduragent [version]";
    };

export function parseCoachCliInvocation(argv: readonly string[]): CoachCliInvocation {
  if (argv.length === 0) return { kind: "repl" };
  if (argv.length === 1 && (argv[0] === "version" || argv[0] === "--version")) {
    return { kind: "version" };
  }
  return { kind: "usage", message: "Usage: enduragent [version]" };
}
