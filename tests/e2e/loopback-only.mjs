// Test-process preload: refuse external provider fetches even if an env override
// is accidentally omitted. This file is never imported by application code.
// Production runtime validation redirects Exa here without weakening the app's
// production prohibition on EXA_TEST_BASE_URL.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (
    url.origin === "https://api.exa.ai" &&
    process.env.EXA_PRODUCTION_FIXTURE_URL &&
    process.env.EXA_API_KEY === "test-exa-not-a-secret"
  ) {
    const fixture = new URL(process.env.EXA_PRODUCTION_FIXTURE_URL);
    if (fixture.protocol !== "http:" || fixture.hostname !== "127.0.0.1")
      throw new Error("Invalid production fixture origin");
    url.protocol = fixture.protocol;
    url.host = fixture.host;
  }
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error(
      `Non-loopback fetch blocked by fixture harness: ${url.origin}`,
    );
  return originalFetch(
    input instanceof Request ? new Request(url, input) : url,
    init,
  );
};
