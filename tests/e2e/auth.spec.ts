import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { register } from "./auth-helper";

const origin = "http://127.0.0.1:3100";
async function fill(page: Page, email: string) {
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
}
async function signIn(page: Page, email: string) {
  await fill(page, email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function shot(page: Page, name: string) {
  if (process.env.PREVIEW_DIR)
    await page.screenshot({
      path: join(process.env.PREVIEW_DIR, `${name}.png`),
      fullPage: true,
    });
}

test("email entry comes first, including old URLs, and private APIs require a session", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Get started" }).first()).toHaveAttribute("href", "/register");
  for (const path of ["/onboarding"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/register$/);
    await expect(
      page.getByRole("heading", { name: "Welcome to Sidekick" }),
    ).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
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

test("email entry leads to chat and returning by email restores the saved profile", async ({
  page,
}) => {
  const email = `alex-${crypto.randomUUID()}@example.test`;
  await page.goto("/");
  await page.getByRole("link", { name: "Get started" }).first().click();
  await signIn(page, email);
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel("Account menu", { exact: true }).click();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Email unverified", { exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("Account menu", { exact: true }).click();
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
  await page.getByLabel("Account menu", { exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/onboarding")).status()).toBe(401);
  await signIn(page, email.toUpperCase());
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  expect((await (await page.request.get("/api/auth")).json()).account.id).toBe(
    account.id,
  );
  await shot(page, "registered-onboarding-simulated-profile");
});

test("profile and calendar persist across browsers while different emails have separate data", async ({
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
  await signIn(second, email);
  await expect(
    second.getByText("alex.calendar@example.test", { exact: true }),
  ).toBeVisible();
  expect(
    (await (await second.request.get(origin + "/api/auth")).json()).account.id,
  ).toBe(account.id);
  await second.getByLabel("Account menu", { exact: true }).click();
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

test("invalid email creates no session and normalized email reopens the same profile", async ({
  page,
  request,
}) => {
  const { email, account } = await register(request);
  const bad = await page.request.post("/api/auth", {
    headers: { origin },
    data: { action: "request_code", email: "bad-address" },
  });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).errors).toHaveProperty("email");
  expect(
    (await (await page.request.get("/api/auth")).json()).account,
  ).toBeNull();
  await page.goto("/register");
  await signIn(page, `  ${email.toUpperCase()}  `);
  await expect(page).toHaveURL(/\/onboarding$/);
  const restored = (await (await page.request.get("/api/auth")).json()).account;
  expect(restored.id).toBe(account.id);
  expect(restored.email).toBe(email);
});

test("email input survives a failed request and retry prevents duplicate submission", async ({
  page,
}) => {
  const email = `retry-${crypto.randomUUID()}@example.test`;
  let attempts = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/auth", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    attempts += 1;
    if (attempts === 1) return route.abort("failed");
    await pending;
    return route.continue();
  });
  await page.goto("/login?next=https://untrusted.example");
  await fill(page, email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("form", { name: "Continue with email" }).getByRole("alert"),
  ).toHaveText(
    "Could not reach SF Sidekick. Try again.",
  );
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(email);
  await shot(page, "email-retry");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  try {
    await expect(page.getByRole("button", { name: "Please wait…" })).toBeDisabled();
    await expect(page.getByLabel("Email", { exact: true })).toBeDisabled();
    await page.keyboard.press("Enter");
    expect(attempts).toBe(2);
  } finally {
    release();
  }
  await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveValue(/^\d{6}$/);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
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

test("email entry reflows at mobile and desktop widths and supports autofill and keyboard", async ({
  page,
}) => {
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/register");
    await expect(page.getByLabel("Email", { exact: true })).toHaveAttribute(
      "autocomplete",
      "email",
    );
    await expect(page.getByRole("textbox")).toHaveCount(1);
    await page.keyboard.press("Tab");
    await expect(page.getByLabel("Email", { exact: true })).toBeFocused();
    await fill(
      page,
      "a.long.email.address.for.a.networking.participant@example.test",
    );
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeFocused();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await shot(page, `registration-${width}`);
  }
});

test("a wrong code creates no session", async ({ page }) => {
  const email = `wrong-${crypto.randomUUID()}@example.test`;
  await page.goto("/register");
  await fill(page, email);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const code = page.getByLabel("Sign-in code", { exact: true });
  const value = await code.inputValue();
  await code.fill(String((Number(value) + 1) % 1_000_000).padStart(6, "0"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText("Enter the latest 6-digit code from your email.")).toBeVisible();
  expect((await (await page.request.get("/api/auth")).json()).account).toBeNull();
});

test("account deletion removes the account and signs out", async ({ page }) => {
  const { email, account } = await register(page.request);
  await page.goto("/onboarding");
  await page.getByLabel("Account menu", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete account", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  expect((await (await page.request.get("/api/auth")).json()).account).toBeNull();
  const again = await register(page.request, email);
  expect(again.account.id).not.toBe(account.id);
});

test("account API rejects cross-origin and forged payloads and rate limits repeated entry", async ({
  request,
}) => {
  const email = `rate-${crypto.randomUUID()}@example.test`;
  expect(
    (
      await request.post("/api/auth", {
        headers: { origin: "https://untrusted.example" },
        data: { action: "request_code", email },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/auth", {
        headers: { origin },
        data: {
          action: "request_code",
          email,
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
          data: { action: "request_code", email },
        })
      ).status(),
    ).toBe(200);
  const blocked = await request.post("/api/auth", {
    headers: { origin },
    data: { action: "request_code", email: email.toUpperCase() },
  });
  expect(blocked.status()).toBe(429);
  expect(blocked.headers()["retry-after"]).toBe("900");
});
