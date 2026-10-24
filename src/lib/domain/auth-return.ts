export function authReturnPath(value: unknown): string {
  return typeof value === "string" &&
    (value === "/network" || /^\/connect\/[A-Za-z0-9_-]{43}$/.test(value))
    ? value
    : "/onboarding";
}
