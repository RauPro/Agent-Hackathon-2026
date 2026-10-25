import { expect, test, type Browser, type Page } from "@playwright/test";
import { join } from "node:path";
import { validContext } from "../fixtures";
import { register } from "./auth-helper";

const origin = "http://127.0.0.1:3100";

async function person(browser: Browser, name: string) {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const { account, email } = await register(page.request);
  const profile = validContext();
  profile.profile.name = name;
  profile.profile.bio = "Builds production AI agents and TypeScript software.";
  profile.profile.offers = "AI engineering and reliable deployment experience.";
  profile.trip.start = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  profile.trip.end = new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10);
  expect((await page.request.post("/api/context", {
    headers: { origin },
    data: { context: profile, baseRevision: 0, requestId: crypto.randomUUID(), confirmed: true },
  })).status()).toBe(200);
  const state = await (await page.request.get("/api/network")).json();
  expect((await page.request.post("/api/network", {
    headers: { origin },
    data: {
      action: "settings",
      settings: {
        revision: state.settings.revision,
        discoverable: false,
        visibility: { ...state.settings.visibility, profile: "friends", goal: "friends" },
        area: null,
      },
    },
  })).status()).toBe(200);
  return { context, page, account, email, state };
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

const composer = (page: Page) => page.getByLabel("Your message", { exact: true });
async function shot(page: Page, name: string) {
  if (process.env.PREVIEW_DIR) await page.screenshot({
    path: join(process.env.PREVIEW_DIR, `${name}.png`),
    fullPage: !(await page.locator("#chat-agent-panel:modal").count()),
  });
}

// The app uses its real account, profile, connection and dialogue services here.
// Only external OpenAI and Google traffic is handled by the existing E2E fixtures.
test("the shared header keeps navigation and account controls consistent, and preserves the chat draft", async ({ browser }) => {
  const alex = await person(browser, "Alex Workspace");
  try {
    await alex.page.setViewportSize({ width: 1280, height: 900 });
    await alex.page.goto("/onboarding");
    await expect(alex.page.getByRole("complementary", { name: "Agent conversations", exact: true }).first()).toBeVisible();
    await expect(alex.page.getByRole("heading", { name: "No agent conversations yet" })).toBeVisible();
    await expect(alex.page.locator(".workspace-profile")).toBeVisible();
    await expect(alex.page.getByRole("main")).toHaveCount(1);
    await composer(alex.page).fill("Keep this thought while I check my connections.");
    await noOverflow(alex.page);
    await shot(alex.page, "chat-workspace-desktop");
    for (const destination of ["Network", "Chat"] as const) {
      const header = alex.page.getByRole("banner");
      await expect(header.getByRole("link", { name: "Chat", exact: true })).toHaveAttribute("href", "/onboarding");
      await expect(header.getByRole("link", { name: "Network", exact: true })).toHaveAttribute("href", "/network");
      await header.getByLabel("Account menu", { exact: true }).click();
      await expect(header.getByText(alex.email, { exact: true })).toBeVisible();
      await alex.page.keyboard.press("Escape");
      await header.getByRole("link", { name: destination, exact: true }).click();
      await expect(header.getByRole("link", { name: destination, exact: true })).toHaveAttribute("aria-current", "page");
    }
    await expect(composer(alex.page)).toHaveValue("Keep this thought while I check my connections.");
    await alex.page.reload();
    await expect(composer(alex.page)).toHaveValue("Keep this thought while I check my connections.");
    await composer(alex.page).fill("No commitments");
    await alex.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(composer(alex.page)).toHaveValue("");
    await alex.page.reload();
    await expect(composer(alex.page)).toHaveValue("");
  } finally { await alex.context.close(); }
});

test("mobile conversations show real exchanges and actions without losing the main chat", async ({ browser }) => {
  test.setTimeout(60000);
  const alex = await person(browser, "Alex Workspace");
  const maya = await person(browser, "Maya Workspace");
  try {
    expect((await alex.page.request.post("/api/network", {
      headers: { origin },
      data: { action: "connect", toUserId: maya.account.id, source: "qr", token: maya.state.settings.qrToken, context: "Met at a production AI meetup." },
    })).status()).toBe(200);
    expect((await maya.page.request.post("/api/network", {
      headers: { origin },
      data: { action: "connection", toUserId: alex.account.id, decision: "accept" },
    })).status()).toBe(200);
    let networkReads = 0;
    alex.page.on("request", (request) => {
      if (request.method() === "GET" && new URL(request.url()).pathname === "/api/network") networkReads += 1;
    });
    await alex.page.goto("/onboarding");
    const draft = "I want to remember my question about production agents.";
    await composer(alex.page).fill(draft);
    expect(networkReads).toBe(0);
    const inputHandle = await composer(alex.page).elementHandle();
    const trigger = alex.page.getByRole("button", { name: "Agent conversations", exact: true });
    await trigger.click();
    const panel = alex.page.getByRole("dialog", { name: "Agent conversations", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Open agent conversation with Maya Workspace", exact: true }).click();
    expect(networkReads).toBeGreaterThan(0);
    await expect(alex.page).toHaveURL(new RegExp(`onboarding\\?agents=1&person=${maya.account.id}$`));
    const conversation = panel.getByRole("region", { name: "Conversation with Maya Workspace", exact: true });
    await expect(conversation.getByText("We both build AI agents in production. Would comparing our approaches to reliable deployments be useful?", { exact: true })).toBeVisible({ timeout: 25000 });
    await expect(conversation.getByText("Comparing production experience could help both people. I will ask my user which project they would like to discuss.", { exact: true })).toBeVisible({ timeout: 25000 });
    await panel.getByRole("button", { name: "Pause conversation", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Conversation paused", exact: true })).toBeVisible();
    await shot(alex.page, "chat-workspace-mobile-conversation");
    await panel.getByRole("button", { name: "All conversations", exact: false }).click();
    const thread = panel.getByRole("button", { name: "Open agent conversation with Maya Workspace", exact: true });
    await expect(thread).toBeVisible();
    await expect(thread).toBeFocused();
    await alex.page.goBack();
    await expect(conversation).toBeVisible();
    await alex.page.goForward();
    await expect(thread).toBeFocused();
    await alex.page.goBack();
    await expect(conversation).toBeVisible();
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < 12; i += 1) {
        await alex.page.keyboard.press(key);
        const focus = await alex.page.evaluate(() => ({
          inside: !!document.activeElement?.closest("#chat-agent-panel"),
          modal: !!document.querySelector("#chat-agent-panel:modal"),
          tag: document.activeElement?.tagName,
        }));
        expect(focus.inside, `${key} must stay in the panel; focused ${focus.tag}`).toBe(true);
        expect(focus.modal).toBe(true);
      }
    }
    await alex.page.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
    await expect(trigger).toBeFocused();
    await expect(composer(alex.page)).toHaveValue(draft);
    expect(await inputHandle?.evaluate((node) => node.isConnected)).toBe(true);
    await alex.page.goBack();
    await expect(panel).toBeVisible();
    await expect(conversation).toBeVisible();
    for (const width of [320, 1280, 390]) {
      await alex.page.setViewportSize({ width, height: 900 });
      await noOverflow(alex.page);
      await expect(alex.page.getByRole("region", { name: "Conversation with Maya Workspace", exact: true })).toBeVisible();
      await expect(composer(alex.page)).toHaveValue(draft);
      expect(await inputHandle?.evaluate((node) => node.isConnected)).toBe(true);
      expect(await alex.page.evaluate(() => !!document.activeElement?.closest("#chat-agent-panel"))).toBe(true);
      await shot(alex.page, `chat-workspace-conversation-${width}`);
    }
    await alex.page.reload();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Conversation paused", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Close agent conversations", exact: true }).click();
    await expect(composer(alex.page)).toHaveValue(draft);
  } finally {
    await alex.context.close();
    await maya.context.close();
  }
});

test("the mobile panel contains an actionable empty state and recovers from a network error", async ({ browser }) => {
  const alex = await person(browser, "Alex Empty Workspace");
  try {
    let fail = true;
    await alex.page.route("**/api/network", (route) => {
      if (fail && route.request().method() === "GET") return route.fulfill({ status: 503, json: { message: "Conversations are temporarily unavailable." } });
      return route.continue();
    });
    await alex.page.goto("/onboarding");
    await composer(alex.page).fill("My draft survives a failed sidebar request.");
    await alex.page.getByRole("button", { name: "Agent conversations", exact: true }).click();
    const panel = alex.page.getByRole("dialog", { name: "Agent conversations", exact: true });
    await expect(panel.getByRole("alert")).toBeVisible();
    await shot(alex.page, "chat-workspace-mobile-error");
    fail = false;
    await panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "No agent conversations yet" })).toBeVisible();
    await expect(panel.getByRole("link", { name: "Find your people", exact: true })).toHaveAttribute("href", "/network?view=connections");
    await noOverflow(alex.page);
    await shot(alex.page, "chat-workspace-mobile-empty");
    await alex.page.keyboard.press("Escape");
    await expect(composer(alex.page)).toHaveValue("My draft survives a failed sidebar request.");
  } finally { await alex.context.close(); }
});
