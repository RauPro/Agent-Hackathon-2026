export function networkDemoEnabled() {
  return (
    process.env.SIDEKICK_DEMO === "1" &&
    !!process.env.DATABASE_PATH?.endsWith(".demo.sqlite")
  );
}
