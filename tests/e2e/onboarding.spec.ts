import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { validContext } from "../fixtures";
import { register } from "./auth-helper";

test.beforeEach(async ({ page, request }) => {
  await register(request);
  await page.context().addCookies((await request.storageState()).cookies);
});

const origin = "http://127.0.0.1:3100";
const intro =
  "I'm Alex Rivera, a product engineer building TypeScript agents in production. I'm in SF from October 24 to November 5, 2026, looking for a founding engineer role on a small team. I can share my experience building agents and working in product teams.";
async function send(page: Page, message: string) {
  await page.getByLabel("Your message", { exact: true }).fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
}
async function shot(page: Page, name: string) {
  if (process.env.PREVIEW_DIR)
    await page.screenshot({
      path: join(process.env.PREVIEW_DIR, `${name}.png`),
      fullPage: true,
    });
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("a paragraph builds a reviewable profile; corrections remain drafts until confirmed", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByLabel("Your message", { exact: true })).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(0);
  await expect(page.locator("select")).toHaveCount(0);
  await shot(page, "chat-mobile-connected-test-fixture");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to conversation" }),
  ).toBeFocused();
  await send(page, intro);
  await expect(
    page.getByRole("button", { name: "Review profile" }),
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/state")).json()).context,
  ).toBeNull();
  await page.getByRole("button", { name: "Review profile" }).click();
  await expect(page.locator(".inline-review")).toContainText("Alex Rivera");
  await expect(page.locator(".inline-review")).toContainText("Not set");
  await noOverflow(page);
  await page
    .getByRole("button", { name: "Confirm profile", exact: true })
    .click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  await send(
    page,
    "Actually, I'm hiring a founding engineer for my agent startup.",
  );
  await expect(
    page.getByRole("button", { name: "Review profile" }),
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/state")).json()).context.goal.type,
  ).toBe("seeking_role");
  await page.getByRole("button", { name: "Review profile" }).click();
  await expect(page.locator(".inline-review")).toContainText(
    "Hire an engineer",
  );
  await page
    .getByRole("button", { name: "Confirm profile", exact: true })
    .click();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Profile saved", { exact: true })).toBeVisible();
  expect((await (await page.request.get("/api/state")).json()).revision).toBe(
    2,
  );
  await shot(page, "chat-confirmed-mobile-test-fixture");
});

test("reflows at 320px and desktop; a reload restores messages and an unconfirmed draft", async ({
  page,
}) => {
  for (const width of [320, 1280]) {
    await page.context().clearCookies();
    await register(page.request);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(
      page.getByLabel("Your message", { exact: true }),
    ).toBeVisible();
    await noOverflow(page);
    await shot(page, `chat-empty-${width}-test-fixture`);
    await send(page, intro);
    await expect(
      page.getByRole("button", { name: "Review profile" }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByText(intro, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review profile" }).click();
    await expect(page.locator(".inline-review")).toContainText("Alex Rivera");
    await noOverflow(page);
    await shot(page, `chat-draft-${width}-test-fixture`);
    expect((await (await page.request.get("/api/state")).json()).revision).toBe(
      0,
    );
  }
});

test("a lost turn response keeps the input and retries without duplicate messages", async ({
  page,
}) => {
  await page.goto("/");
  let lose = true;
  const keys: string[] = [];
  await page.route("**/api/onboarding", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    keys.push(route.request().postDataJSON().requestId);
    if (lose) {
      lose = false;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort("failed");
    } else await route.continue();
  });
  await send(page, intro);
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not confirm the reply" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue(
    intro,
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Review profile" }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  expect(
    (await (await page.request.get("/api/onboarding")).json()).chat.messages,
  ).toHaveLength(3);
});

test("provider errors preserve input and ambiguous or invalid dates cannot be confirmed", async ({
  page,
}) => {
  await page.goto("/");
  await send(page, "FAIL_PROVIDER");
  await expect(
    page.getByRole("alert").filter({ hasText: "Could not get a reply" }),
  ).toBeVisible();
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue(
    "FAIL_PROVIDER",
  );
  expect(
    (await (await page.request.get("/api/onboarding")).json()).chat.messages,
  ).toHaveLength(1);
  await send(page, intro);
  await expect(
    page.getByRole("button", { name: "Review profile" }),
  ).toBeVisible();
  await send(page, "I leave before I arrive");
  await expect(
    page.getByText(
      "That departure is before your arrival. What is your departure date?",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review profile" }),
  ).toHaveCount(0);
  const state = (await (await page.request.get("/api/onboarding")).json()).chat;
  const response = await page.request.post("/api/onboarding", {
    headers: { origin },
    data: {
      action: "confirm",
      revision: state.revision,
      requestId: crypto.randomUUID(),
    },
  });
  expect(response.status()).toBe(400);
});

test("a stale tab recovers newer messages and keeps its unsent text", async ({
  page,
  context,
}) => {
  await page.goto("/");
  await expect(page.getByLabel("Your message", { exact: true })).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await expect(other.getByLabel("Your message", { exact: true })).toBeVisible();
  await send(page, intro);
  await expect(
    page.getByRole("button", { name: "Review profile" }),
  ).toBeVisible();
  await send(other, "No commitments");
  await expect(
    other.getByRole("alert").filter({ hasText: "The conversation changed" }),
  ).toBeVisible();
  await other.getByRole("button", { name: "Load conversation" }).click();
  await expect(other.getByText(intro, { exact: true })).toBeVisible();
  await expect(other.getByLabel("Your message", { exact: true })).toHaveValue(
    "No commitments",
  );
  await other.getByRole("button", { name: "Send message" }).click();
  await expect(
    other.getByText(
      "Noted: no fixed commitments. Your availability can stay open for now.",
      { exact: true },
    ),
  ).toBeVisible();
});

test("missing connection is explicit, and the composer supports keyboard newlines", async ({
  page,
}) => {
  await page.route("**/api/onboarding", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, configured: false } });
  });
  await page.goto("/");
  await expect(page.getByText("OpenAI is not connected")).toBeVisible();
  await page
    .getByLabel("Your message", { exact: true })
    .fill("A message before connecting");
  await page.getByLabel("Your message", { exact: true }).press("Shift+Enter");
  await expect(page.getByLabel("Your message", { exact: true })).toHaveValue(
    "A message before connecting\n",
  );
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeDisabled();
  await shot(page, "chat-preview-disconnected");
});

test("API rejects origin, forged state, and oversized input; sessions remain isolated", async ({
  request,
  playwright,
}) => {
  const opened = await request.get("/api/onboarding");
  expect(opened.headers()["cache-control"]).toContain("no-store");
  expect(opened.headers()["set-cookie"]).toBeUndefined();
  const body = {
    action: "message",
    revision: 0,
    requestId: crypto.randomUUID(),
    message: intro,
  };
  expect(
    (
      await request.post("/api/onboarding", {
        data: body,
        headers: { origin: "https://untrusted.example" },
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/onboarding", {
        data: { ...body, draft: {} },
        headers: { origin },
      })
    ).status(),
  ).toBe(400);
  expect(
    (
      await request.post("/api/onboarding", {
        data: "x".repeat(40000),
        headers: { origin, "Content-Type": "application/json" },
      })
    ).status(),
  ).toBe(413);
  expect(
    (
      await request.post("/api/onboarding", { data: body, headers: { origin } })
    ).status(),
  ).toBe(200);
  const second = await playwright.request.newContext({ baseURL: origin });
  await register(second);
  expect(
    (await (await second.get("/api/onboarding")).json()).chat.draft.name,
  ).toBe("");
  await second.dispose();
});

test("existing confirmed profiles survive the switch from forms to chat", async ({
  request,
}) => {
  await request.get("/api/state");
  expect(
    (
      await request.post("/api/context", {
        headers: { origin },
        data: {
          context: validContext(),
          baseRevision: 0,
          requestId: crypto.randomUUID(),
          confirmed: true,
        },
      })
    ).status(),
  ).toBe(200);
  const state = (await (await request.get("/api/onboarding")).json()).chat;
  expect(state.confirmed).toBe(true);
  expect(state.draft.name).toBe("Alex Rivera");
});
