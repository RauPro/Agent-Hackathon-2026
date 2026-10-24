import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { exaConfigured, exaContents, exaSearch } from "../src/lib/server/exa";

const query = {
  query: "San Francisco builders",
  objective: "Find individual registration pages",
  includeDomains: ["luma.com", "lu.ma"],
};
const signal = () => new AbortController().signal;
const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
beforeEach(() => {
  vi.stubEnv("EXA_API_KEY", "fixture-only-key");
  vi.stubEnv("EXA_TEST_BASE_URL", "http://127.0.0.1:3103");
  const root = globalThis as typeof globalThis & {
    sidekickExa: { active: number; starts: number[] };
  };
  root.sidekickExa.starts = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("sends the exact search shape, key header, objective and no publication/category filters", async () => {
  const fetcher = vi.fn(async () =>
    response({
      results: [
        {
          url: "https://luma.com/event",
          text: "Fixture",
          highlights: ["date"],
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  expect(await exaSearch(query, signal())).toHaveLength(1);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://127.0.0.1:3103/search");
  expect(init).toMatchObject({
    method: "POST",
    cache: "no-store",
    redirect: "error",
    headers: { "x-api-key": "fixture-only-key" },
  });
  expect(JSON.parse(init.body as string)).toEqual({
    ...query,
    type: "auto",
    numResults: 10,
    userLocation: "US",
    contents: {
      text: { maxCharacters: 4000 },
      highlights: {
        query:
          "event date, start time, time zone, venue, address, price, registration status",
      },
    },
  });
  await exaSearch(
    {
      query: query.query,
      objective: query.objective,
      excludeDomains: ["luma.com"],
    },
    signal(),
  );
  expect(
    JSON.parse(
      (fetcher.mock.calls[1] as unknown as [string, RequestInit])[1]
        .body as string,
    ).contents.extras,
  ).toEqual({ links: 3 });
  await exaSearch(
    {
      ...query,
      userIdentifier: "private-user",
      coordinates: [1, 2],
    } as typeof query,
    signal(),
  );
  expect(
    JSON.stringify(
      (fetcher.mock.calls[2] as unknown as [string, RequestInit])[1],
    ),
  ).not.toMatch(/private-user|userIdentifier|coordinates|User-Agent/);
});
it.each([400, 401, 402, 403, 404])(
  "does not retry rejected HTTP %i",
  async (status) => {
    const f = vi.fn(async () => response({}, status));
    vi.stubGlobal("fetch", f);
    await expect(exaSearch(query, signal())).rejects.toMatchObject({
      code: "rejected",
    });
    expect(f).toHaveBeenCalledTimes(1);
  },
);
it.each([429, 500, 503])("retries transient HTTP %i once", async (status) => {
  const f = vi
    .fn()
    .mockResolvedValueOnce(response({}, status, { "Retry-After": "0" }))
    .mockResolvedValueOnce(response({ results: [] }));
  vi.stubGlobal("fetch", f);
  expect(await exaSearch(query, signal())).toEqual([]);
  expect(f).toHaveBeenCalledTimes(2);
});
it("retries a network failure only once", async () => {
  const f = vi.fn(async () => {
    throw new TypeError("network fixture");
  });
  vi.stubGlobal("fetch", f);
  await expect(exaSearch(query, signal())).rejects.toMatchObject({
    code: "transient",
  });
  expect(f).toHaveBeenCalledTimes(2);
});
it("honors Retry-After and aborts within the caller deadline", async () => {
  vi.useFakeTimers();
  const controller = new AbortController(),
    f = vi.fn(async () => response({}, 429, { "Retry-After": "10" }));
  vi.stubGlobal("fetch", f);
  const pending = exaSearch(query, controller.signal);
  const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
  await vi.advanceTimersByTimeAsync(999);
  expect(f).toHaveBeenCalledTimes(1);
  controller.abort();
  await assertion;
  expect(f).toHaveBeenCalledTimes(1);
});
it("propagates aborts to an in-flight fetch", async () => {
  const controller = new AbortController();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal!.addEventListener("abort", () =>
            reject(init.signal!.reason),
          );
          controller.abort();
        }),
    ),
  );
  await expect(exaSearch(query, controller.signal)).rejects.toMatchObject({
    code: "timeout",
  });
});
it("times out each search attempt and stops after one transient retry", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("fixture timeout")), ms);
    return controller.signal;
  });
  const f = vi.fn(
    (_url, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal!.addEventListener("abort", () =>
          reject(init.signal!.reason),
        ),
      ),
  );
  vi.stubGlobal("fetch", f);
  const pending = expect(exaSearch(query, signal())).rejects.toMatchObject({
    code: "timeout",
  });
  await vi.advanceTimersByTimeAsync(24500);
  await pending;
  expect(f).toHaveBeenCalledTimes(2);
});
it("bounds process-wide Exa concurrency at six and search starts at ten per second", async () => {
  vi.useFakeTimers();
  let inFlight = 0,
    maximum = 0;
  const f = vi.fn(async () => {
    maximum = Math.max(maximum, ++inFlight);
    await new Promise((r) => setTimeout(r, 100));
    inFlight--;
    return response({ results: [] });
  });
  vi.stubGlobal("fetch", f);
  const pending = Promise.all(
    Array.from({ length: 12 }, () => exaSearch(query, signal())),
  );
  await vi.advanceTimersByTimeAsync(950);
  expect(f).toHaveBeenCalledTimes(10);
  expect(maximum).toBe(6);
  await vi.advanceTimersByTimeAsync(300);
  await pending;
  expect(f).toHaveBeenCalledTimes(12);
});
it.each([{ results: "wrong" }, { results: [{ url: 1 }] }, {}])(
  "validates provider response with Zod",
  async (body) => {
    const f = vi.fn(async () => response(body));
    vi.stubGlobal("fetch", f);
    await expect(exaSearch(query, signal())).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(f).toHaveBeenCalledTimes(1);
  },
);
it("uses one bounded contents call and preserves per-URL statuses", async () => {
  const payload = {
    results: [{ url: "https://luma.com/event", text: "fresh" }],
    statuses: [
      { id: "https://luma.com/event", status: "success", source: "cached" },
    ],
  };
  const f = vi.fn(async () => response(payload));
  vi.stubGlobal("fetch", f);
  expect(await exaContents(["https://luma.com/event"], signal())).toEqual(
    payload,
  );
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("http://127.0.0.1:3103/contents");
  expect(JSON.parse(init.body as string)).toEqual({
    urls: ["https://luma.com/event"],
    text: { maxCharacters: 8000 },
    maxAgeHours: 24,
    livecrawlTimeout: 8000,
  });
  await expect(
    exaContents(Array(7).fill("https://luma.com/event"), signal()),
  ).rejects.toMatchObject({ code: "rejected" });
});
it("does not retry enrichment and rejects invalid statuses", async () => {
  const f = vi.fn(async () => response({}, 503));
  vi.stubGlobal("fetch", f);
  await expect(
    exaContents(["https://luma.com/e"], signal()),
  ).rejects.toMatchObject({ code: "transient" });
  expect(f).toHaveBeenCalledTimes(1);
  f.mockImplementation(async () =>
    response({ results: [], statuses: [{ id: "x", status: "invented" }] }),
  );
  await expect(
    exaContents(["https://luma.com/e"], signal()),
  ).rejects.toMatchObject({ code: "invalid_response" });
});
it.each([
  "http://exa.example.com",
  "https://127.0.0.1:3103",
  "http://user:password@127.0.0.1:3103",
  "http://127.0.0.1:3103/path",
])("rejects unsafe test endpoint %s", (endpoint) => {
  vi.stubEnv("EXA_TEST_BASE_URL", endpoint);
  expect(exaConfigured()).toBe(false);
});
it("never enables the test override in production and never fetches with a missing key", async () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(exaConfigured()).toBe(false);
  vi.stubEnv("EXA_TEST_BASE_URL", "");
  expect(exaConfigured()).toBe(true);
  vi.stubEnv("EXA_API_KEY", "");
  const f = vi.fn();
  vi.stubGlobal("fetch", f);
  await expect(exaSearch(query, signal())).rejects.toMatchObject({
    code: "not_configured",
  });
  expect(f).not.toHaveBeenCalled();
});
