export function networkDemoEnabled() {
  if (process.env.TURSO_DATABASE_URL)
    return (
      process.env.SIDEKICK_DEMO === "1" &&
      process.env.DATABASE_PURPOSE === "demo"
    );
  return (
    process.env.SIDEKICK_DEMO === "1" &&
    !!process.env.DATABASE_PATH?.endsWith(".demo.sqlite")
  );
}
