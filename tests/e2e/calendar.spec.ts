import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { register } from "./auth-helper";

test.beforeEach(async ({ page, request }) => {
  await register(request);
  await page.context().addCookies((await request.storageState()).cookies);
});

const origin = "http://127.0.0.1:3100";
const intro =
  "I'm Alex Rivera, a product engineer building TypeScript agents in production. I'm in SF from October 24 to November 5, 2026, looking for a founding engineer role.";
async function profile(page: Page) {
  await page.getByLabel("Your message", { exact: true }).fill(intro);
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Review profile" }).click();
  await page
    .getByRole("button", { name: "Confirm profile", exact: true })
    .click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
}
async function connect(page: Page, choice = "Allow test calendar") {
  await page
    .getByRole("button", { name: "Connect Google Calendar", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Simulated Google consent" }),
  ).toBeVisible();
  await page.getByRole("link", { name: choice, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your plans in SF" }),
  ).toBeVisible();
}
async function shot(page: Page, name: string) {
  if (process.env.PREVIEW_DIR)
    await page.screenshot({
      path: join(process.env.PREVIEW_DIR, `${name}.png`),
      fullPage: true,
    });
}

test("calendar OAuth, sync, selection, and disconnect gate onboarding completion", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await profile(page);
  expect(
    (await (await page.request.get("/api/calendar")).json()).onboardingComplete,
  ).toBe(false);
  const cookieBefore = (await context.cookies()).find(
    (cookie) => cookie.name === "sf_sidekick_session",
  )!.value;
  await page
    .getByLabel("Your message", { exact: true })
    .fill("An unsent correction");
  await connect(page);
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue(
    "An unsent correction",
  );
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies()).find(
      (cookie) => cookie.name === "sf_sidekick_session",
    )!.value,
  ).not.toBe(cookieBefore);
  const status = await (await page.request.get("/api/calendar")).json();
  expect(status).toMatchObject({
    availabilityReady: true,
    profileReady: true,
    email: "alex.calendar@example.test",
    selectedIds: ["primary@example.test"],
  });
  expect(JSON.stringify(status)).not.toMatch(
    /encryptedTokens|accessToken|refreshToken/,
  );
  await page.locator(".calendar-options summary").click();
  await page
    .getByLabel(
      "Work calendar with a deliberately long name for mobile layout verification",
      { exact: true },
    )
    .check();
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".calendar-options summary")).toHaveText(
    "2 calendars included",
  );
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await shot(page, `calendar-synced-${width}-simulated`);
  }
  await page.reload();
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toBeVisible();
  await page.locator(".calendar-options summary").click();
  await expect(
    page.getByLabel(
      "Work calendar with a deliberately long name for mobile layout verification",
      { exact: true },
    ),
  ).toBeChecked();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect Google Calendar", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  expect(
    (await (await page.request.get("/api/calendar")).json()).onboardingComplete,
  ).toBe(false);
});

test("a connected account stays incomplete until dates and profile are confirmed", async ({
  page,
}) => {
  await page.goto("/");
  await connect(page);
  await expect(
    page.getByText("Add your SF trip dates in the chat to check availability."),
  ).toBeVisible();
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toHaveCount(0);
  await profile(page);
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toBeVisible();
});

test("denial and partial permissions preserve the profile without claiming connection", async ({
  page,
}) => {
  await page.goto("/");
  await profile(page);
  await connect(page, "Deny test calendar");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Google Calendar was not connected" }),
  ).toBeVisible();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  await connect(page, "Allow incomplete permissions");
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Allow calendar access in Google" }),
  ).toBeVisible();
  expect((await (await page.request.get("/api/calendar")).json()).status).toBe(
    "not_connected",
  );
});

test("a per-calendar Google error removes readiness and recovers after deselection", async ({
  page,
}) => {
  await page.goto("/");
  await profile(page);
  await connect(page);
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toBeVisible();
  await page.locator(".calendar-options summary").click();
  await page
    .getByLabel("Unavailable calendar (test fixture)", { exact: true })
    .check();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "A selected calendar could not be checked" }),
  ).toBeVisible();
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toHaveCount(0);
  expect(
    (await (await page.request.get("/api/calendar")).json()).availabilityReady,
  ).toBe(false);
  await shot(page, "calendar-partial-failure-simulated");
  await page
    .getByLabel("Unavailable calendar (test fixture)", { exact: true })
    .uncheck();
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toBeVisible();
});

test("missing configuration is explicit and does not prevent saving the profile", async ({
  page,
}) => {
  await page.route("**/api/calendar", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), configured: false },
    });
  });
  await page.goto("/");
  await expect(
    page.getByText(/Google Calendar setup is pending/),
  ).toBeVisible();
  await profile(page);
  await expect(
    page.getByText("✓ Onboarding complete", { exact: true }),
  ).toHaveCount(0);
  await shot(page, "calendar-setup-pending-simulated");
});

test("calendar endpoints reject foreign origins, forged choices, and OAuth state", async ({
  request,
  playwright,
}) => {
  await request.get("/api/onboarding");
  expect(
    (
      await request.post("/api/calendar/connect", {
        headers: { origin: "https://untrusted.example" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/calendar", {
        headers: { origin },
        data: { action: "sync", sessionId: "forged" },
      })
    ).status(),
  ).toBe(400);
  const started = await request.post("/api/calendar/connect", {
    headers: { origin },
  });
  expect(started.headers()["set-cookie"]).toContain("SameSite=lax");
  const state = new URL((await started.json()).url).searchParams.get("state");
  const other = await playwright.request.newContext({ baseURL: origin });
  await register(other);
  await other.get("/api/onboarding");
  const rejected = await other.get(
    `/api/calendar/callback?state=${state}&code=fake`,
    { maxRedirects: 0 },
  );
  expect(rejected.headers().location).toContain("calendar=invalid_state");
  expect((await (await request.get("/api/calendar")).json()).status).toBe(
    "not_connected",
  );
  await other.dispose();
});
