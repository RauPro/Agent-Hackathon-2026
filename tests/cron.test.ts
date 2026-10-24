import { afterEach, expect, it, vi } from "vitest";
const drain = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/server/network-worker", () => ({
  drainNetworkWork: drain,
}));
import { GET } from "../src/app/api/cron/network/route";

afterEach(() => {
  vi.unstubAllEnvs();
  drain.mockReset();
});
const request = (authorization?: string) =>
  new Request("https://sidekick.example.test/api/cron/network", {
    headers: authorization ? { authorization } : {},
  });

it("requires the cron secret rather than a user session or malformed bearer header", async () => {
  vi.stubEnv("CRON_SECRET", "");
  expect((await GET(request())).status).toBe(401);
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  for (const value of [
    undefined,
    "Bearer wrong-secret",
    "Bearer ééééééééééééééé",
  ])
    expect((await GET(request(value))).status).toBe(401);
  expect(drain).not.toHaveBeenCalled();
});

it("runs only a bounded authorized drain and reports failures without claiming completion", async () => {
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  drain.mockResolvedValueOnce(3);
  expect(await (await GET(request("Bearer test-cron-secret"))).json()).toEqual({
    processed: 3,
  });
  drain.mockRejectedValueOnce(new Error("Fixture database failure"));
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect((await GET(request("Bearer test-cron-secret"))).status).toBe(503);
  } finally {
    spy.mockRestore();
  }
});
