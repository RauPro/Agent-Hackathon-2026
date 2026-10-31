import { expect, type APIRequestContext } from "@playwright/test";
export async function register(
  request: APIRequestContext,
  email = `person-${crypto.randomUUID()}@example.test`,
) {
  const headers = { origin: "http://127.0.0.1:3100" };
  const sent = await request.post("/api/auth", {
    headers,
    data: { action: "request_code", email },
  });
  expect(sent.status()).toBe(200);
  const { devCode } = await sent.json();
  const response = await request.post("/api/auth", {
    headers,
    data: { action: "verify", email, code: devCode },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["set-cookie"]).toContain("HttpOnly");
  const account = (await response.json()).account;
  return { email, account };
}
