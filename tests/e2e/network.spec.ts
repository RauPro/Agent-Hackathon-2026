import { test, expect, type Browser, type Page } from "@playwright/test";
import { join } from "node:path";
import { validContext } from "../fixtures";
import { register, testPassword } from "./auth-helper";

const origin = "http://127.0.0.1:3100";

async function person(
  browser: Browser,
  name: string,
  goal: "seeking_role" | "hiring" = "seeking_role",
) {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  const { account, email } = await register(page.request);
  const profile = validContext();
  profile.profile.name = name;
  profile.profile.bio = `${name} builds AI agents and TypeScript software in production. Private project: Orchard.`;
  profile.profile.offers =
    "AI agent engineering, TypeScript infrastructure, and startup product development.";
  profile.goal = {
    type: goal,
    text:
      goal === "hiring"
        ? "Hire a founding engineer with AI agent and TypeScript production experience."
        : "Find a founding engineer role building AI agents and TypeScript products.",
  };
  const tomorrow = new Date(Date.now() + 2 * 86400000)
    .toISOString()
    .slice(0, 10);
  profile.trip.start = tomorrow;
  profile.trip.end = new Date(Date.now() + 12 * 86400000)
    .toISOString()
    .slice(0, 10);
  const saved = await page.request.post("/api/context", {
    headers: { origin },
    data: {
      context: profile,
      baseRevision: 0,
      requestId: crypto.randomUUID(),
      confirmed: true,
    },
  });
  expect(saved.status()).toBe(200);
  const state = await (await page.request.get("/api/network")).json();
  return { page, context, account, email, state, date: tomorrow };
}

async function connect(
  a: Awaited<ReturnType<typeof person>>,
  b: Awaited<ReturnType<typeof person>>,
) {
  const response = await a.page.request.post("/api/network", {
    headers: { origin },
    data: {
      action: "connect",
      toUserId: b.account.id,
      source: "qr",
      token: b.state.settings.qrToken,
      context: "We met at an AI event.",
    },
  });
  expect(response.status()).toBe(200);
  const accepted = await b.page.request.post("/api/network", {
    headers: { origin },
    data: { action: "connection", toUserId: a.account.id, decision: "accept" },
  });
  expect(accepted.status()).toBe(200);
}

async function shot(page: Page, name: string) {
  if (process.env.PREVIEW_DIR)
    await page.screenshot({
      path: join(process.env.PREVIEW_DIR, `${name}.png`),
      fullPage: true,
    });
}

test("a QR image opens a name-only preview; a request requires acceptance and persists", async ({
  browser,
}) => {
  const alex = await person(browser, "Alex Rivera");
  const pedro = await person(browser, "Pedro Chen");
  try {
    await pedro.page.goto("/network");
    await pedro.page.getByRole("button", { name: "Connect with QR" }).click();
    const code = pedro.page.getByAltText("Your Sidekick connection QR code");
    await expect(code).toBeVisible();
    const png = await code.screenshot();
    await alex.page.goto("/network");
    await alex.page.getByRole("button", { name: "Connect with QR" }).click();
    await alex.page.locator('input[type="file"]').setInputFiles({
      name: "connection.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(alex.page).toHaveURL(
      new RegExp(`/connect/${pedro.state.settings.qrToken}$`),
    );
    await expect(
      alex.page.getByRole("heading", { name: "Connect with Pedro Chen" }),
    ).toBeVisible();
    await expect(alex.page.getByText("Orchard", { exact: false })).toHaveCount(
      0,
    );
    expect(
      (await (await pedro.page.request.get("/api/network")).json()).connections,
    ).toHaveLength(0);
    await alex.page
      .getByLabel("Where did you meet? (optional)")
      .fill("We met at an AI event.");
    await alex.page
      .getByRole("button", { name: "Send connection request" })
      .click();
    await expect(alex.page.getByRole("status")).toContainText(
      "Connection request sent",
    );
    await pedro.page.goto("/network");
    await pedro.page.getByRole("button", { name: /^Requests/ }).click();
    await pedro.page.getByRole("button", { name: "Accept connection" }).click();
    await pedro.page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(
      pedro.page.getByRole("heading", { name: "Alex Rivera" }),
    ).toBeVisible();
    await pedro.page.reload();
    await pedro.page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(
      pedro.page.getByText("Connected", { exact: true }),
    ).toBeVisible();
    await shot(pedro.page, "network-connected-mobile");
    for (const width of [320, 1280]) {
      await pedro.page.setViewportSize({ width, height: 900 });
      expect(
        await pedro.page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await shot(pedro.page, `network-connected-${width}`);
    }
  } finally {
    await alex.context.close();
    await pedro.context.close();
  }
});

test("discovery recommends a reciprocal match after explicit sharing consent", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const alex = await person(browser, "Alex Rivera");
  const agustin = await person(browser, "Agustin Park", "hiring");
  try {
    for (const current of [alex, agustin]) {
      await current.page.goto("/network");
      await current.page
        .getByText("Discovery and sharing", { exact: true })
        .click();
      await current.page
        .getByLabel("Let Sidekick recommend me to compatible people")
        .check();
      for (const name of [
        "Experience and projects",
        "Professional goal",
        "SF dates and neighborhood",
      ]) {
        await current.page
          .getByRole("combobox", { name: new RegExp(`^${name}`) })
          .selectOption("network");
      }
      await current.page
        .getByRole("button", { name: "Save sharing preferences" })
        .click();
      await expect(
        current.page.getByText("Discovery is off.", { exact: false }),
      ).toHaveCount(0);
    }
    await alex.page.reload();
    const recommendation = alex.page.locator("article").filter({
      has: alex.page.getByRole("heading", {
        name: "Agustin Park",
        exact: true,
      }),
    });
    await expect(recommendation).toBeVisible({ timeout: 25000 });
    await expect(recommendation).toContainText("For you:");
    await expect(recommendation).toContainText("For Agustin Park:");
    await expect(
      recommendation.getByRole("button", {
        name: "Request connection",
        exact: true,
      }),
    ).toBeVisible();
    await shot(alex.page, "network-proactive-match-mobile");
    await recommendation
      .getByRole("button", { name: "Request connection", exact: true })
      .click();
    await expect(
      recommendation.getByText("Connection request pending"),
    ).toBeVisible();
    await agustin.page.reload();
    await agustin.page.getByRole("button", { name: /^Requests/ }).click();
    await expect(
      agustin.page.getByRole("heading", { name: "Alex Rivera", exact: true }),
    ).toBeVisible();
    await agustin.page
      .getByRole("button", { name: "Accept connection" })
      .click();
    await alex.page.reload();
    await expect(
      alex.page.getByText("Connected · coordinate from Connections", {
        exact: true,
      }),
    ).toBeVisible();
  } finally {
    for (const current of [alex, agustin]) {
      const state = await (
        await current.page.request.get("/api/network")
      ).json();
      const { qrToken: _qr, ...settings } = state.settings;
      void _qr;
      await current.page.request.post("/api/network", {
        headers: { origin },
        data: {
          action: "settings",
          settings: { ...settings, discoverable: false },
        },
      });
      await current.context.close();
    }
  }
});

test("a private profile needs an explicit one-time answer and blocking revokes the response", async ({
  browser,
}) => {
  const alex = await person(browser, "Alex Rivera");
  const pedro = await person(browser, "Pedro Chen");
  try {
    await connect(alex, pedro);
    await pedro.page.goto("/network");
    await pedro.page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await pedro.page
      .getByText("Ask about an opportunity", { exact: true })
      .click();
    const purpose =
      "Would an AI infrastructure founding engineer role interest Alex?";
    const requestIds: string[] = [];
    await pedro.page.route("**/api/network", async (route) => {
      if (
        route.request().method() !== "POST" ||
        route.request().postDataJSON().action !== "query"
      )
        return route.continue();
      requestIds.push(route.request().postDataJSON().requestId);
      if (requestIds.length === 1)
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            message: "The request could not be sent. Please try again.",
          }),
        });
      return route.continue();
    });
    await pedro.page
      .getByLabel("What opportunity are you exploring?")
      .fill(purpose);
    await pedro.page
      .getByRole("button", { name: "Send request to their Sidekick" })
      .click();
    await expect(
      pedro.page
        .getByRole("alert")
        .filter({ hasText: "The request could not be sent" }),
    ).toContainText("The request could not be sent");
    await expect(
      pedro.page.getByLabel("What opportunity are you exploring?"),
    ).toHaveValue(purpose);
    await pedro.page
      .getByRole("button", { name: "Send request to their Sidekick" })
      .click();
    await expect(pedro.page.getByRole("status")).toContainText("Request sent");
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).toBe(requestIds[0]);
    await pedro.page.getByRole("button", { name: /^Requests/ }).click();
    await expect(pedro.page.getByText("Orchard", { exact: false })).toHaveCount(
      0,
    );
    await expect(pedro.page.getByText("Waiting for an answer")).toBeVisible();
    await alex.page.goto("/network");
    await alex.page.getByRole("button", { name: /^Requests/ }).click();
    await expect(alex.page.getByText(purpose)).toBeVisible();
    await alex.page
      .getByRole("textbox", { name: "Experience and projects", exact: true })
      .fill(
        "I have built production AI agents and would be open to a conversation.",
      );
    await alex.page
      .getByRole("button", { name: "Share these answers" })
      .click();
    await expect(
      alex.page.getByRole("button", { name: "Share these answers" }),
    ).toBeDisabled();
    await alex.page
      .getByRole("button", { name: "Decline to share more" })
      .click();
    await expect(
      alex.page.getByText("Declined", { exact: true }),
    ).toBeVisible();
    await pedro.page.reload();
    await pedro.page.getByRole("button", { name: /^Requests/ }).click();
    await expect(
      pedro.page.getByText(
        "I have built production AI agents and would be open to a conversation.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(pedro.page.getByText("Orchard", { exact: false })).toHaveCount(
      0,
    );
    await alex.page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await alex.page.getByText("Manage connection", { exact: true }).click();
    await alex.page.getByRole("button", { name: "Block", exact: true }).click();
    await expect(alex.page.getByText("Blocked", { exact: true })).toBeVisible();
    await pedro.page.reload();
    await pedro.page.getByRole("button", { name: /^Requests/ }).click();
    await expect(
      pedro.page.getByText(
        "I have built production AI agents and would be open to a conversation.",
        { exact: true },
      ),
    ).toHaveCount(0);
  } finally {
    await alex.context.close();
    await pedro.context.close();
  }
});

test("sign-in returns to the scanned connection and foreign links are rejected", async ({
  browser,
}) => {
  const alex = await person(browser, "Alex Rivera");
  const pedro = await person(browser, "Pedro Chen");
  const guest = await browser.newContext({ baseURL: origin });
  try {
    const page = await guest.newPage();
    const path = `/connect/${pedro.state.settings.qrToken}`;
    await page.goto(path);
    await expect(page).toHaveURL(/\/login\?next=/);
    await page
      .getByRole("textbox", { name: "Email", exact: true })
      .fill(alex.email);
    await page.getByLabel("Password", { exact: true }).fill(testPassword);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(`${origin}${path}`);
    await expect(
      page.getByRole("heading", { name: "Connect with Pedro Chen" }),
    ).toBeVisible();
    await page.goto("/network");
    await page.getByRole("button", { name: "Connect with QR" }).click();
    await page
      .getByRole("textbox", { name: "Connection link" })
      .fill(`https://example.com${path}`);
    await page.getByRole("button", { name: "Open connection" }).click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Use a Sidekick connection code" }),
    ).toContainText("Use a Sidekick connection code or link from this site.");
    await expect(page).toHaveURL(`${origin}/network`);
  } finally {
    await alex.context.close();
    await pedro.context.close();
    await guest.close();
  }
});

test("a meeting uses manual availability only when calendar is missing and requires two time approvals", async ({
  browser,
}) => {
  const alex = await person(browser, "Alex Rivera");
  const agustin = await person(browser, "Agustin Park", "hiring");
  try {
    await connect(alex, agustin);
    await alex.page.goto("/network");
    await alex.page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await alex.page.getByText("Coordinate a meeting", { exact: true }).click();
    await alex.page
      .getByLabel("What would you like to discuss?")
      .fill("Discuss the AI founding engineer opportunity.");
    await alex.page
      .getByLabel("Proposed meeting place")
      .fill("A public cafe in Downtown SF");
    await alex.page
      .getByRole("button", { name: "Propose meeting", exact: true })
      .click();
    await expect(alex.page.getByRole("status")).toContainText("Proposed");
    for (const current of [alex, agustin]) {
      await current.page.goto("/network");
      await current.page.getByRole("button", { name: /^Requests/ }).click();
      await current.page
        .getByLabel("Date in SF", { exact: true })
        .fill(alex.date);
      await current.page.getByLabel("Available from").fill("10:00");
      await current.page.getByLabel("Until", { exact: true }).fill("12:00");
      await current.page
        .getByRole("button", { name: "Find a time together" })
        .click();
      await expect(
        current.page.getByRole("button", { name: "Find a time together" }),
      ).toHaveCount(0);
    }
    let showProviderFailure = true;
    let retryPayload: Record<string, unknown> | null = null;
    await alex.page.route("**/api/network", async (route) => {
      if (route.request().method() !== "GET" || !showProviderFailure)
        return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      data.meetings[0] = {
        ...data.meetings[0],
        status: "awaiting_permission",
        options: [],
        error: "The calendar provider is temporarily unavailable. Try again.",
      };
      await route.fulfill({ response, json: data });
    });
    await alex.page.route("**/api/meetings", async (route) => {
      if (route.request().postDataJSON().action === "opt_in") {
        retryPayload = route.request().postDataJSON();
        showProviderFailure = false;
      }
      await route.continue();
    });
    await alex.page.reload();
    await alex.page.getByRole("button", { name: /^Requests/ }).click();
    await expect(
      alex.page.getByText(
        "The calendar provider is temporarily unavailable. Try again.",
      ),
    ).toBeVisible();
    await expect(alex.page.getByText(/No common time was found/)).toHaveCount(
      0,
    );
    await expect(
      alex.page.getByText(
        "Checks weekdays, 9 AM–6 PM SF time, within the first 14 days of your overlapping stays.",
      ),
    ).toBeVisible();
    await alex.page.getByRole("button", { name: "Retry availability" }).click();
    await expect(
      alex.page
        .getByRole("button", { name: "Approve this time and place" })
        .first(),
    ).toBeVisible();
    expect(retryPayload).not.toHaveProperty("manualSlots");
    await expect(
      alex.page.getByText(
        "The calendar provider is temporarily unavailable. Try again.",
      ),
    ).toHaveCount(0);
    await alex.page
      .getByRole("button", { name: "Approve this time and place" })
      .first()
      .click();
    await expect(
      alex.page.getByText(
        "You approved this time. Waiting for your connection.",
      ),
    ).toBeVisible();
    await expect(
      alex.page.getByRole("link", { name: "Download calendar file" }),
    ).toHaveCount(0);
    await agustin.page.reload();
    await agustin.page.getByRole("button", { name: /^Requests/ }).click();
    await expect(
      agustin.page.getByText(
        /Alex Rivera proposed .* Approve it or choose another option./,
      ),
    ).toBeVisible();
    await agustin.page
      .getByRole("button", { name: "Approve this time and place" })
      .nth(1)
      .click();
    await expect(
      agustin.page.getByText(
        "You approved this time. Waiting for your connection.",
      ),
    ).toBeVisible();
    await expect(
      agustin.page.getByRole("link", { name: "Download calendar file" }),
    ).toHaveCount(0);
    await alex.page.reload();
    await alex.page.getByRole("button", { name: /^Requests/ }).click();
    await expect(
      alex.page.getByText(
        /Agustin Park proposed .* Approve it or choose another option./,
      ),
    ).toBeVisible();
    await alex.page
      .getByRole("button", { name: "Approve this time and place" })
      .nth(1)
      .click();
    await expect(
      alex.page.getByText("Both people approved", { exact: true }),
    ).toBeVisible();
    await agustin.page.reload();
    await agustin.page.getByRole("button", { name: /^Requests/ }).click();
    await expect(
      agustin.page.getByText("Both people approved", { exact: true }),
    ).toBeVisible();
    await expect(
      agustin.page.getByRole("link", { name: "Download calendar file" }),
    ).toBeVisible();
    await expect(
      agustin.page.getByText(/Sidekick has not added it to Google Calendar/),
    ).toBeVisible();
    await shot(agustin.page, "network-meeting-approved-mobile");
  } finally {
    await alex.context.close();
    await agustin.context.close();
  }
});
