import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { join } from "node:path";
import { register } from "./auth-helper";

const origin = "http://127.0.0.1:3100";
const fixture = "http://127.0.0.1:3103";
async function scenario(
  request: APIRequestContext,
  name: string,
  reset = true,
) {
  expect(
    (
      await request.post(`${fixture}/scenario`, {
        data: { scenario: name, reset },
      })
    ).ok(),
  ).toBe(true);
}
const section = (page: Page) =>
  page.getByRole("region", { name: "Events for your goal" });
async function showEvent(page: Page, title: string) {
  const heading = section(page).locator("h3").filter({ hasText: title });
  await expect(heading).toHaveCount(1);
  if (!(await heading.isVisible()))
    await section(page).getByText("Browse events", { exact: false }).click();
  await expect(heading).toBeVisible();
}
async function confirm(page: Page) {
  await page.getByRole("button", { name: "Review profile" }).click();
  await page
    .getByRole("button", { name: "Confirm profile", exact: true })
    .click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
}
async function message(page: Page, text: string) {
  await page.getByLabel("Your message", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Review profile" }),
  ).toBeVisible();
}
async function intro(page: Page) {
  await page.goto("/onboarding");
  await message(
    page,
    "I'm Alex Rivera, a product engineer building TypeScript agents. DISCOVERY_PROFILE: I want a founding engineer role and can offer agent-building experience. Use the fixture trip dates.",
  );
  await expect(section(page)).toHaveCount(0);
  await confirm(page);
}
test.beforeEach(async ({ page, request }) => {
  await scenario(request, "ready");
  await register(request);
  await page.context().addCookies((await request.storageState()).cookies);
});
test.afterEach(async ({ request }) => {
  await scenario(request, "ready");
});

test("confirmation starts background discovery before Calendar; cards show supported facts and an official link", async ({
  page,
}) => {
  await intro(page);
  await expect(section(page).getByRole("status")).toContainText(
    "Finding events",
  );
  await showEvent(page, "Early Team Demos");
  await expect(section(page)).toContainText("5:00 PM–9:00 PM PT");
  await expect(section(page)).toContainText("Fixture Hall · San Francisco");
  await expect(section(page)).toContainText("Free");
  await expect(section(page)).toContainText("Registration approval required.");
  await expect(
    page.getByRole("button", { name: "Connect Google Calendar", exact: true }),
  ).toBeVisible();
  const onboarding = await (await page.request.get("/api/onboarding")).json();
  expect(onboarding.calendar.onboardingComplete).toBe(false);
  const wrongRevision = await page.request.post("/api/discovery", {
    headers: { origin, "X-Sidekick-Account": onboarding.account.id },
    data: { action: "start", revision: 99, requestId: crypto.randomUUID() },
  });
  expect(wrongRevision.status()).toBe(409);
  expect((await wrongRevision.json()).code).toBe("profile_changed");
  const link = section(page).getByRole("link", { name: "Open on Eventbrite" });
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(link).toHaveAttribute(
    "href",
    "https://eventbrite.com/e/123456789",
  );
  await page.context().route("https://eventbrite.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>Synthetic registration page. No registration action.</p>",
    }),
  );
  const before = await (await page.request.get("/api/events/attendance")).json();
  expect(before.events).toEqual([]);
  const popup = page.waitForEvent("popup");
  await link.click();
  const opened = await popup;
  await opened.close();
  expect((await (await page.request.get("/api/events/attendance")).json()).events).toEqual([]);
  await expect(section(page).getByRole("button", { name: "I registered", exact: true })).toBeVisible();
  await section(page).getByText("Source details", { exact: true }).click();
  await expect(section(page)).toContainText("Also listed on Partiful");
  await expect(section(page)).toContainText(
    "Small engineering teams demonstrate their early-stage agent products.",
  );
  expect(
    (await (await page.request.get(`${fixture}/stats`)).json()).invalidKeys,
  ).toBe(0);
});
test("reload and a second tab reuse the same paid search result", async ({
  page,
}) => {
  await intro(page);
  await showEvent(page, "Early Team Demos");
  const stats = await (await page.request.get(`${fixture}/stats`)).json();
  expect(stats.search).toBe(4);
  await page.reload();
  await showEvent(page, "Early Team Demos");
  const second = await page.context().newPage();
  await second.goto("/onboarding");
  await showEvent(second, "Early Team Demos");
  expect(
    (await (await page.request.get(`${fixture}/stats`)).json()).search,
  ).toBe(4);
  await second.close();
});
test("unconfirmed changes mark saved cards stale; confirming a new goal replaces them", async ({
  page,
}) => {
  await intro(page);
  await showEvent(page, "Early Team Demos");
  await message(
    page,
    "Actually, I'm hiring a founding engineer for my agent startup.",
  );
  await expect(section(page)).toContainText(
    "Based on your saved profile. Confirm your changes to update these.",
  );
  expect(
    (await (await page.request.get(`${fixture}/stats`)).json()).search,
  ).toBe(4);
  await confirm(page);
  await showEvent(page, "TypeScript Builders Lab");
  await expect(
    section(page).getByRole("heading", { name: "Early Team Demos" }),
  ).toHaveCount(0);
  await expect(section(page)).toContainText("$25");
  await expect(
    section(page).getByRole("link", { name: "Open on Luma" }),
  ).toBeVisible();
  expect(
    (await (await page.request.get(`${fixture}/stats`)).json()).search,
  ).toBe(8);
});
test("all-source outage is failed, Calendar stays usable, and retry succeeds", async ({
  page,
  request,
}) => {
  await scenario(request, "failed");
  await intro(page);
  await expect(section(page)).toContainText(
    "Couldn't check event sources.",
  );
  await expect(
    page.getByRole("button", { name: "Connect Google Calendar", exact: true }),
  ).toBeEnabled();
  expect((await (await request.get(`${fixture}/stats`)).json()).search).toBe(8);
  await scenario(request, "ready", false);
  await section(page).getByRole("button", { name: "Try again" }).click();
  await showEvent(page, "Early Team Demos");
});
test("one source failure is partial, while only past events are empty", async ({
  page,
  request,
}) => {
  await scenario(request, "partial");
  await intro(page);
  await expect(section(page)).toContainText(
    "Some sources couldn't be checked.",
  );
  await showEvent(page, "Early Team Demos");
  await section(page).getByText("Search details", { exact: true }).click();
  await expect(section(page)).toContainText("Partiful: not checked");
  await scenario(request, "past", false);
  await section(page).getByRole("button", { name: "Try again" }).click();
  await expect(section(page)).toContainText(
    "No events matched your goal and dates in the sources we checked.",
  );
  await expect(section(page).locator(".event-card")).toHaveCount(0);
  await expect(section(page)).toContainText("0 candidates passed checks.");
});
test("cards reflow at 320, 390 and desktop widths and are reachable from the keyboard", async ({
  page,
}) => {
  await intro(page);
  await showEvent(page, "Early Team Demos");
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const link = section(page).getByRole("link", {
      name: "Open on Eventbrite",
    });
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    if (process.env.PREVIEW_DIR)
      await page.screenshot({
        path: join(process.env.PREVIEW_DIR, `discovery-${width}.png`),
        fullPage: true,
      });
  }
  await page.reload();
  await showEvent(page, "Early Team Demos");
  let reached = false;
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab");
    if (
      await section(page)
        .getByRole("link", { name: "Open on Eventbrite" })
        .evaluate((el) => el === document.activeElement)
    ) {
      reached = true;
      break;
    }
  }
  expect(reached).toBe(true);
});
test("discovery API enforces origin, account identity, strict inputs and profile revisions", async ({
  request,
}) => {
  const headers = {
    origin,
    "X-Sidekick-Account": (await (await request.get("/api/auth")).json())
      .account.id,
  };
  const input = {
    action: "start",
    revision: 1,
    requestId: crypto.randomUUID(),
  };
  expect((await request.post("/api/discovery", { data: input })).status()).toBe(
    403,
  );
  expect(
    (
      await request.post("/api/discovery", { headers, data: "not JSON" })
    ).status(),
  ).toBe(415);
  expect(
    (
      await request.post("/api/discovery", {
        headers,
        data: { ...input, context: {} },
      })
    ).status(),
  ).toBe(400);
  expect(
    (await request.post("/api/discovery", { headers, data: input })).status(),
  ).toBe(400);
  expect(
    (
      await request.get("/api/discovery", {
        headers: { "X-Sidekick-Account": "another-account" },
      })
    ).status(),
  ).toBe(401);
  const status = await request.get("/api/discovery");
  expect(status.headers()["cache-control"]).toContain("no-store");
  expect((await status.json()).discovery).toBeNull();
});
test("daily limit, not configured, trip ended and network errors leave Calendar usable", async ({
  page,
}) => {
  await intro(page);
  await showEvent(page, "Early Team Demos");
  const saved = await (await page.request.get("/api/discovery")).json();
  for (const state of [
    { ...saved, dailyLimitReached: true },
    { ...saved, configured: false },
    { ...saved, tripPast: true },
    {
      ...saved,
      configured: false,
      discovery: { ...saved.discovery, status: "running" },
    },
    {
      ...saved,
      tripPast: true,
      discovery: { ...saved.discovery, status: "running" },
    },
  ]) {
    await page.route("**/api/discovery", (route) =>
      route.fulfill({ json: state }),
    );
    await page.reload();
    await expect(page.getByRole("button", { name: "Connect Google Calendar", exact: true })).toBeEnabled();
    if (state.dailyLimitReached)
      await expect(section(page)).toContainText(
        "Event discovery is paused for today.",
      );
    await page.unroute("**/api/discovery");
  }
  await page.route("**/api/discovery", (route) =>
    route.fulfill({
      status: 503,
      json: { message: "Couldn't check event sources. Try again." },
    }),
  );
  await page.reload();
  await expect(section(page).getByRole("alert")).toBeVisible();
  await expect(section(page)).toHaveAttribute("aria-busy", "false");
  await expect(page.getByRole("button", { name: "Connect Google Calendar", exact: true })).toBeEnabled();
});


test("registration is an explicit self-report, persists, and preserves global sharing", async ({ page }) => {
  await intro(page);
  await showEvent(page, "Early Team Demos");
  await section(page).getByRole("button", { name: "I registered", exact: true }).click();
  const audience = section(page).getByLabel("Who can see this registration?");
  await expect(audience).toHaveValue("private");
  await audience.selectOption("friends");
  await expect(section(page)).toContainText("Your event sharing is set to Only me.");
  await section(page).getByRole("button", { name: "Save registration", exact: true }).click();
  await expect(section(page).getByText("Registration saved", { exact: true })).toBeVisible();
  const saved = await (await page.request.get("/api/events/attendance")).json();
  expect(saved.eventVisibility).toBe("private");
  expect(saved.events).toHaveLength(1);
  expect(saved.events[0]).toMatchObject({ attendance: "registered", visibility: "friends", sourceMode: "user_report", title: "Early Team Demos" });
  await page.reload();
  await section(page).getByText("Browse events", { exact: false }).click();
  await expect(section(page).getByText("Registration saved", { exact: true })).toBeVisible();
  await expect(section(page)).toContainText("Reported by you; admission isn't verified.");
  await section(page).getByRole("button", { name: "Edit sharing", exact: true }).click();
  await expect(audience).toHaveValue("friends");
  await audience.selectOption("private");
  await section(page).getByRole("button", { name: "Save sharing", exact: true }).click();
  await expect(section(page).getByText("Registration saved", { exact: true })).toBeVisible();
  const updated = await (await page.request.get("/api/events/attendance")).json();
  expect(updated.eventVisibility).toBe("private");
  expect(updated.events).toHaveLength(1);
  expect(updated.events[0]).toMatchObject({ id: saved.events[0].id, attendance: "registered", visibility: "private" });
  await section(page).getByRole("link", { name: "Your events", exact: true }).click();
  await expect(page.locator("#my-events")).toContainText("Early Team Demos");
  await expect(page.locator("#my-events")).toContainText("Registered");
  await page.getByRole("button", { name: "Remove event", exact: true }).click();
  expect((await (await page.request.get("/api/events/attendance")).json()).events).toEqual([]);
});

test("dismissing a suggestion survives reload without removing browsable events or adding chat messages", async ({ page }) => {
  await intro(page);
  await showEvent(page, "Early Team Demos");
  const before = await (await page.request.get("/api/onboarding")).json();
  await section(page).getByRole("button", { name: "Dismiss", exact: true }).click();
  await expect(section(page).getByRole("heading", { name: "Early Team Demos" })).not.toBeVisible();
  await page.reload();
  await expect(section(page).getByRole("button", { name: "Dismiss", exact: true })).toHaveCount(0);
  await section(page).getByText("Browse events", { exact: false }).click();
  await showEvent(page, "Early Team Demos");
  expect((await (await page.request.get("/api/discovery")).json()).suggestion).toBeNull();
  const after = await (await page.request.get("/api/onboarding")).json();
  expect(after.chat.messages).toEqual(before.chat.messages);
});
