import { afterEach, expect, it, vi } from "vitest";
import { ContextStore } from "../src/lib/server/store";
import { networkDemoEnabled } from "../src/lib/server/demo-mode";

afterEach(() => vi.unstubAllEnvs());

it("refuses demo mode on the normal database before opening or modifying it", () => {
  vi.stubEnv("SIDEKICK_DEMO", "1");
  expect(() => new ContextStore("./data/sidekick.sqlite")).toThrow(
    "separate database",
  );
});

it("labels demo data only when both explicit mode and an isolated path are configured", () => {
  vi.stubEnv("SIDEKICK_DEMO", "1");
  vi.stubEnv("DATABASE_PATH", "./data/sidekick.sqlite");
  expect(networkDemoEnabled()).toBe(false);
  vi.stubEnv("DATABASE_PATH", "/private/tmp/network.demo.sqlite");
  expect(networkDemoEnabled()).toBe(true);
  vi.stubEnv("SIDEKICK_DEMO", "0");
  expect(networkDemoEnabled()).toBe(false);
});
