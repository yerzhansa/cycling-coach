export function requireDesktopDaemonHome(
  expectedAthleteHome: string,
  actualAthleteHome: string,
): void {
  if (actualAthleteHome !== expectedAthleteHome) {
    throw new Error("desktop daemon home mismatch");
  }
}
