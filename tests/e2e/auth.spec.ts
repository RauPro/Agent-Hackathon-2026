import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { register, testPassword } from "./auth-helper";

const origin = "http://127.0.0.1:3100";
async function fill(page: Page, email: string, password = testPassword) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
}
async function shot(page: Page, name: string) {
  if (process.env.PREVIEW_DIR)
    await page.screenshot({
      path: join(process.env.PREVIEW_DIR, `${name}.png`),
      fullPage: true,
    });
}

test("registration comes first, including old URLs, and private APIs require sign-in", async ({
  page,
  request,
}) => {
  for (const path of ["/", "/es", "/?onboarding=1", "/onboarding"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/register$/);
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await expect(page.getByLabel("Your message", { exact: true })).toHaveCount(
      0,
    );
  }
  for (const path of ["/api/onboarding", "/api/state", "/api/calendar"])
    expect((await request.get(path)).status()).toBe(401);
  expect(
    (
      await request.post("/api/onboarding", {
        headers: { origin },
        data: {
          action: "message",
          message: "Hello",
          revision: 0,
          requestId: crypto.randomUUID(),
        },
      })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/calendar/connect", { headers: { origin } })
    ).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/calendar", {
        headers: { origin },
        data: { action: "sync" },
      })
    ).status(),
  ).toBe(401);
});

test("email registration leads to chat and signing back in restores the saved profile", async ({
  page,
}) => {
  const email = `alex-${crypto.randomUUID()}@example.test`;
  await page.goto("/");
  await fill(page, email);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Email unverified", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Your message", { exact: true })
    .fill(
      "I'm Alex Rivera, a product engineer with experience building TypeScript agents. I'm in SF October 24 to November 5, 2026, seeking a founding engineer role.",
    );
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Review profile" }).click();
  await page
    .getByRole("button", { name: "Confirm profile", exact: true })
    .click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  const account = (await (await page.request.get("/api/auth")).json()).account;
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/onboarding")).status()).toBe(401);
  await fill(page, email.toUpperCase());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  expect((await (await page.request.get("/api/auth")).json()).account.id).toBe(
    account.id,
  );
  await shot(page, "registered-onboarding-simulated-profile");
});

test("account and calendar persist across browsers without sharing data with another user", async ({
  browser,
  page,
}) => {
  const { email, account } = await register(page.request);
  await page.goto("/onboarding");
  await page
    .getByRole("button", { name: "Connect Google Calendar", exact: true })
    .click();
  await page
    .getByRole("link", { name: "Allow test calendar", exact: true })
    .click();
  await expect(
    page.getByText("alex.calendar@example.test", { exact: true }),
  ).toBeVisible();
  const other = await browser.newContext({ baseURL: origin });
  const second = await other.newPage();
  await second.goto(origin + "/login");
  await fill(second, email);
  await second.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    second.getByText("alex.calendar@example.test", { exact: true }),
  ).toBeVisible();
  expect(
    (await (await second.request.get(origin + "/api/auth")).json()).account.id,
  ).toBe(account.id);
  await second.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(second).toHaveURL(/\/login$/);
  const separate = await register(second.request);
  await second.goto(origin + "/onboarding");
  expect(separate.account.id).not.toBe(account.id);
  await expect(
    second.getByRole("button", {
      name: "Connect Google Calendar",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    second.getByText("alex.calendar@example.test", { exact: true }),
  ).toHaveCount(0);
  expect((await (await page.request.get("/api/calendar")).json()).email).toBe(
    "alex.calendar@example.test",
  );
  await other.close();
});

test("invalid and duplicate registration and wrong credentials never expose a profile", async ({
  page,
  request,
}) => {
  const { email } = await register(request);
  await page.goto("/register");
  await fill(page, email.toUpperCase());
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(page.getByRole("form").getByRole("alert")).toContainText(
    "Could not create this account",
  );
  await expect(page).toHaveURL(/\/register$/);
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await fill(page, email, "a wrong password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("form").getByRole("alert")).toHaveText(
    "Email or password is incorrect.",
  );
  expect(
    (await (await page.request.get("/api/auth")).json()).account,
  ).toBeNull();
  const bad = await page.request.post("/api/auth", {
    headers: { origin },
    data: { action: "register", email: "bad-address", password: "short" },
  });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).errors).toHaveProperty("email");
  await shot(page, "login-error");
});

test("stale account headers cannot write into a different signed-in account", async ({
  request,
}) => {
  const first = await register(request);
  await request.post("/api/auth", {
    headers: { origin },
    data: { action: "logout" },
  });
  await register(request);
  const stale = { origin, "X-Sidekick-Account": first.account.id };
  expect(
    (
      await request.post("/api/onboarding", {
        headers: stale,
        data: {
          action: "message",
          message: "Old account message",
          revision: 0,
          requestId: crypto.randomUUID(),
        },
      })
    ).status(),
  ).toBe(401);
  expect(
    (await request.post("/api/calendar/connect", { headers: stale })).status(),
  ).toBe(401);
  expect(
    (
      await request.post("/api/auth", {
        headers: stale,
        data: { action: "logout" },
      })
    ).status(),
  ).toBe(401);
  expect(
    (await (await request.get("/api/onboarding")).json()).chat.messages,
  ).toHaveLength(1);
});

test("registration reflows at mobile and desktop widths and supports password managers and keyboard", async ({
  page,
}) => {
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/register");
    await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute(
      "autocomplete",
      "username",
    );
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
    await page.getByLabel("Password", { exact: true }).fill(testPassword);
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute(
      "type",
      "text",
    );
    await page.getByRole("button", { name: "Hide password" }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByLabel("Password", { exact: true }).fill("");
    await shot(page, `registration-${width}`);
  }
});

test("account API rejects cross-origin and forged payloads and rate limits guessing", async ({
  request,
}) => {
  const email = `rate-${crypto.randomUUID()}@example.test`;
  expect(
    (
      await request.post("/api/auth", {
        headers: { origin: "https://untrusted.example" },
        data: { action: "register", email, password: testPassword },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/auth", {
        headers: { origin },
        data: {
          action: "register",
          email,
          password: testPassword,
          userId: "forged",
        },
      })
    ).status(),
  ).toBe(400);
  for (let n = 0; n < 10; n++)
    expect(
      (
        await request.post("/api/auth", {
          headers: { origin },
          data: { action: "login", email, password: "wrong" },
        })
      ).status(),
    ).toBe(401);
  const blocked = await request.post("/api/auth", {
    headers: { origin },
    data: { action: "login", email, password: "wrong" },
  });
  expect(blocked.status()).toBe(429);
  expect(blocked.headers()["retry-after"]).toBe("900");
});
