import { expect, type APIRequestContext } from "@playwright/test";
export const testPassword = "A long fictional test passphrase!";
export async function register(
  request: APIRequestContext,
  email = `person-${crypto.randomUUID()}@example.test`,
) {
  const response = await request.post("/api/auth", {
    headers: { origin: "http://127.0.0.1:3100" },
    data: { action: "register", email, password: testPassword },
  });
  expect(response.status()).toBe(200);
  expect(response.headers()["set-cookie"]).toContain("HttpOnly");
  const account = (await response.json()).account;
  return { email, account };
}
