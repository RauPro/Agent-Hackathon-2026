import { expect, type APIRequestContext } from "@playwright/test";
export async function register(
  request: APIRequestContext,
  email = `person-${crypto.randomUUID()}@example.test`,
) {
  const response = await request.post("/api/auth", {
    headers: { origin: "http://127.0.0.1:3100" },
    data: { action: "continue", email },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["set-cookie"]).toContain("HttpOnly");
  const account = (await response.json()).account;
  return { email, account };
}
