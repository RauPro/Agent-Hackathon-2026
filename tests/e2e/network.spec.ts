import { test, expect, type Browser, type Page } from "@playwright/test";
import { join } from "node:path";
import { validContext } from "../fixtures";
import { register } from "./auth-helper";

const origin = "http://127.0.0.1:3100";

async function person(
  browser: Browser,
  name: string,
  goal: "seeking_role" | "hiring" = "seeking_role",
  confirmed = true,
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
  if (confirmed) {
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
  }
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

async function shareWithConnections(current: Awaited<ReturnType<typeof person>>) {
  const state = await (await current.page.request.get("/api/network")).json();
  const response = await current.page.request.post("/api/network", {
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
  });
  expect(response.status()).toBe(200);
}

async function shot(page: Page, name: string) {
  if (process.env.PREVIEW_DIR)
    await page.screenshot({
      path: join(process.env.PREVIEW_DIR, `${name}.png`),
      fullPage: true,
    });
}

async function view(page: Page, name: "For you" | "Agents" | "People") {
  await page
    .getByRole("navigation", { name: "Network views" })
    .getByRole("button", { name: new RegExp(`^${name}(?: \\d+)?$`) })
    .click();
}

async function openConversation(page: Page, name: string) {
  await page.goto("/network?view=agents");
  await page
    .getByRole("button", {
      name: `Open agent conversation with ${name}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", {
      name: `Conversation with ${name}`,
      exact: true,
    }),
  ).toBeVisible();
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
    await view(pedro.page, "People");
    await pedro.page.getByRole("button", { name: "Accept connection" }).click();
    await expect(
      pedro.page.getByRole("region", {
        name: "Conversation with Alex Rivera",
        exact: true,
      }),
    ).toBeVisible();
    await expect(pedro.page).toHaveURL(
      new RegExp(`view=agents&person=${alex.account.id}$`),
    );
    await expect(
      pedro.page.getByRole("heading", { name: "Choose what your Sidekick can share" }),
    ).toBeVisible();
    await pedro.page.reload();
    await expect(
      pedro.page.getByRole("region", {
        name: "Conversation with Alex Rivera",
        exact: true,
      }),
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
    await view(pedro.page, "People");
    await expect(
      pedro.page.getByText("Connected", { exact: true }),
    ).toBeVisible();
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
        .getByRole("button", { name: "Sharing", exact: true })
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
        current.page.getByLabel(
          "Let Sidekick recommend me to compatible people",
        ),
      ).toBeChecked();
      await current.page
        .getByRole("region", { name: "Discovery and sharing" })
        .getByRole("button", { name: "Close", exact: true })
        .click();
    }
    await alex.page.reload();
    const recommendation = alex.page.locator("article").filter({
      has: alex.page.getByRole("heading", {
        name: "Agustin Park",
        exact: true,
      }),
    });
    await expect(recommendation).toBeVisible({ timeout: 25000 });
    await recommendation
      .getByText("Why this was suggested", { exact: true })
      .click();
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
    await view(agustin.page, "People");
    await expect(
      agustin.page.getByRole("heading", { name: "Alex Rivera", exact: true }),
    ).toBeVisible();
    await agustin.page
      .getByRole("button", { name: "Accept connection" })
      .click();
    await alex.page.reload();
    await recommendation
      .getByRole("button", { name: "Open agent conversation", exact: true })
      .click();
    await expect(
      alex.page.getByRole("region", {
        name: "Conversation with Agustin Park",
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

test("connected confirmed profiles exchange real turns, ask their owner and continue after a shared answer", async ({ browser }) => {
  test.setTimeout(60000);
  const alex = await person(browser, "Alex Dialogue");
  const pedro = await person(browser, "Pedro Dialogue");
  try {
    for (const current of [alex, pedro]) await shareWithConnections(current);
    const request = await alex.page.request.post("/api/network", {
      headers: { origin },
      data: { action: "connect", toUserId: pedro.account.id, source: "qr", token: pedro.state.settings.qrToken, context: "Met while discussing production AI." },
    });
    expect(request.status()).toBe(200);
    for (const current of [alex, pedro]) {
      const state = await (await current.page.request.get("/api/network")).json();
      expect(state.dialogues).toEqual([]);
    }
    await alex.page.goto("/network?view=agents");
    await expect(alex.page.getByRole("heading", { name: "No agent conversations yet" })).toBeVisible();
    expect((await pedro.page.request.post("/api/network", {
      headers: { origin },
      data: { action: "connection", toUserId: alex.account.id, decision: "accept" },
    })).status()).toBe(200);
    await openConversation(alex.page, "Pedro Dialogue");
    await expect(alex.page.getByText("We both build AI agents in production. Would comparing our approaches to reliable deployments be useful?", { exact: true })).toBeVisible({ timeout: 25000 });
    await expect(alex.page.getByText("Comparing production experience could help both people. I will ask my user which project they would like to discuss.", { exact: true })).toBeVisible({ timeout: 25000 });
    const state = await (await alex.page.request.get("/api/network")).json();
    const dialogue = state.dialogues.find((item: { userId: string }) => item.userId === pedro.account.id);
    expect(dialogue.status).toBe("needs_user");
    expect(dialogue.turns.filter((turn: { kind: string }) => turn.kind === "agent").map((turn: { actorUserId: string }) => turn.actorUserId).sort()).toEqual([alex.account.id, pedro.account.id].sort());
    const owner = dialogue.waitingForUserId === alex.account.id ? alex : pedro;
    const peer = owner === alex ? pedro : alex;
    await openConversation(owner.page, peer === alex ? "Alex Dialogue" : "Pedro Dialogue");
    await openConversation(peer.page, owner === alex ? "Alex Dialogue" : "Pedro Dialogue");
    const question = "Which project would you like to discuss with your connection?";
    await expect(owner.page.getByRole("textbox", { name: question })).toBeVisible();
    await expect(peer.page.getByRole("textbox", { name: question })).toHaveCount(0);
    let releaseStale!: () => void;
    let capturedStale!: () => void;
    const holdStale = new Promise<void>((resolve) => { releaseStale = resolve; });
    const staleCaptured = new Promise<void>((resolve) => { capturedStale = resolve; });
    let held = false;
    await owner.page.route("**/api/network", async (route) => {
      if (route.request().method() !== "GET" || held) return route.continue();
      held = true;
      const response = await route.fetch();
      const json = await response.json();
      capturedStale();
      await holdStale;
      await route.fulfill({ status: response.status(), json, headers: { "x-stale-response-test": "1" } });
    });
    await owner.page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await staleCaptured;
    await owner.page.getByRole("button", { name: "Pause conversation", exact: true }).click();
    await expect(owner.page.getByRole("heading", { name: "Conversation paused", exact: true })).toBeVisible();
    const staleDelivered = owner.page.waitForResponse((response) => response.headers()["x-stale-response-test"] === "1");
    releaseStale();
    await staleDelivered;
    await owner.page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(owner.page.getByRole("heading", { name: "Conversation paused", exact: true })).toBeVisible();
    await expect(owner.page.getByRole("textbox", { name: question })).toHaveCount(0);
    await owner.page.unroute("**/api/network");
    await peer.page.reload();
    await expect(peer.page.getByRole("button", { name: "Resume conversation" })).toHaveCount(0);
    await owner.page.getByRole("button", { name: "Resume conversation" }).click();
    await owner.page.getByRole("textbox", { name: question }).fill("I would like to discuss the production evaluation pipeline I built.");
    await owner.page.getByRole("button", { name: "Share answer and continue" }).click();
    await expect(owner.page.getByRole("heading", { name: "Suggested next step", exact: true })).toBeVisible({ timeout: 25000 });
    await peer.page.reload();
    await expect(peer.page.getByText("I would like to discuss the production evaluation pipeline I built.", { exact: true })).toBeVisible();
    await expect(peer.page.getByText("Shared answer", { exact: true })).toBeVisible();
    await expect(peer.page.getByRole("region", { name: `Conversation with ${owner === alex ? "Alex Dialogue" : "Pedro Dialogue"}`, exact: true }).getByText("Consider a short conversation about production AI projects. Both people still need to approve any meeting time.", { exact: true })).toBeVisible();
    const completed = await (await peer.page.request.get("/api/network")).json();
    expect(completed.meetings).toHaveLength(0);
    expect(completed.settings.discoverable).toBe(false);
    expect(completed.dialogues[0].turns.filter((turn: { kind: string }) => turn.kind === "agent")).toHaveLength(4);
    await shot(peer.page, "network-agent-dialogue-mobile");
    for (const width of [320, 1280]) {
      await peer.page.setViewportSize({ width, height: 900 });
      expect(await peer.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(peer.page, `network-agent-dialogue-${width}`);
    }
  } finally {
    await alex.context.close();
    await pedro.context.close();
  }
});

test("an unconfirmed connection shows whose profile needs confirmation before agents can talk", async ({ browser }) => {
  const alex = await person(browser, "Alex Draft", "seeking_role", false);
  const pedro = await person(browser, "Pedro Confirmed");
  try {
    await connect(alex, pedro);
    await openConversation(alex.page, "Pedro Confirmed");
    await expect(alex.page.getByRole("heading", { name: "Confirm your profile to begin" })).toBeVisible();
    await expect(alex.page.getByRole("link", { name: "Review and confirm profile" })).toHaveAttribute("href", "/onboarding");
    await openConversation(pedro.page, "Sidekick member");
    await expect(pedro.page.getByRole("heading", { name: "Waiting for their profile" })).toBeVisible();
    await expect(pedro.page.getByRole("link", { name: "Review and confirm profile" })).toHaveCount(0);
    for (const current of [alex, pedro]) {
      const state = await (await current.page.request.get("/api/network")).json();
      expect(state.dialogues[0].turns).toEqual([]);
    }
  } finally {
    await alex.context.close();
    await pedro.context.close();
  }
});

test("a private profile needs an explicit one-time answer and blocking revokes the response", async ({
  browser,
}) => {
  const alex = await person(browser, "Alex Rivera");
  const pedro = await person(browser, "Pedro Chen");
  try {
    await connect(alex, pedro);
    await openConversation(pedro.page, "Alex Rivera");
    await pedro.page
      .locator("summary")
      .filter({ hasText: "Ask about an opportunity" })
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
    await expect(pedro.page.getByText("Orchard", { exact: false })).toHaveCount(
      0,
    );
    await expect(
      pedro.page.getByText("Waiting for Alex to decide what to share."),
    ).toBeVisible();
    await expect(
      pedro.page.getByText("Your Sidekick → Alex’s Sidekick", { exact: true }),
    ).toBeVisible();
    await openConversation(alex.page, "Pedro Chen");
    await expect(
      alex.page
        .getByRole("list", { name: "Agent exchange history" })
        .getByText(purpose, { exact: true }),
    ).toBeVisible();
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
      alex.page.getByText("No additional information was shared.", {
        exact: true,
      }),
    ).toBeVisible();
    await pedro.page.reload();
    await expect(
      pedro.page.getByText(
        "I have built production AI agents and would be open to a conversation.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(pedro.page.getByText("Orchard", { exact: false })).toHaveCount(
      0,
    );
    await view(alex.page, "People");
    await alex.page.getByText("Manage connection", { exact: true }).click();
    await alex.page.getByRole("button", { name: "Block", exact: true }).click();
    await expect(alex.page.getByText("Blocked", { exact: true })).toBeVisible();
    await pedro.page.reload();
    await expect(
      pedro.page.getByText(
        "Access revoked. Previously shared information is hidden.",
        { exact: true },
      ),
    ).toBeVisible();
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
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByLabel("Sign-in code", { exact: true })).toHaveValue(/^\d{6}$/);
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
  test.setTimeout(60000);
  const alex = await person(browser, "Alex Rivera");
  const agustin = await person(browser, "Agustin Park", "hiring");
  try {
    await connect(alex, agustin);
    await openConversation(alex.page, "Agustin Park");
    await alex.page
      .locator("summary")
      .filter({ hasText: "Coordinate a meeting" })
      .click();
    await alex.page
      .getByLabel("What would you like to discuss?")
      .fill("Discuss the AI founding engineer opportunity.");
    await alex.page
      .getByLabel("Proposed meeting place (optional)")
      .fill("A public cafe in Downtown SF");
    await alex.page
      .getByRole("button", { name: "Coordinate meeting", exact: true })
      .click();
    await expect.poll(async () => (await (await alex.page.request.get("/api/meetings/chat")).json()).meetings.length).toBe(1);
    const meeting = (await (await alex.page.request.get("/api/meetings/chat")).json()).meetings[0];
    for (const current of [alex, agustin]) {
      await current.page.goto(`/onboarding?agents=0&meeting=${meeting.id}`);
      await expect(current.page.getByText(/Replying about your meeting with/)).toBeVisible();
      await current.page.getByLabel("Your message", { exact: true }).fill("On the first day of my stay, 11:30 AM to 1 PM works for me.");
      await current.page.getByRole("button", { name: "Send message", exact: true }).click();
      await current.page.getByRole("button", { name: "Check these times" }).click();
      await expect(current.page.getByRole("button", { name: "Check these times" })).toHaveCount(0);
    }
    await openConversation(alex.page, "Agustin Park");
    await openConversation(agustin.page, "Alex Rivera");
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
    await expect(
      alex.page.getByText(
        "The calendar provider is temporarily unavailable. Try again.",
      ),
    ).toBeVisible();
    await expect(alex.page.getByText(/No common time was found/)).toHaveCount(
      0,
    );
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
    await expect(
      agustin.page.getByText("Both people approved", { exact: true }),
    ).toBeVisible();
    await expect(
      agustin.page.getByRole("link", { name: "Download calendar file" }),
    ).toBeVisible();
    await expect(
      agustin.page.getByText(/Both people approved. Send a Google Calendar invitation/),
    ).toBeVisible();
    await shot(agustin.page, "network-meeting-approved-mobile");
  } finally {
    await alex.context.close();
    await agustin.context.close();
  }
});

test("agent conversations isolate each person and preserve recorded exchanges through reload and keyboard navigation", async ({
  browser,
}) => {
  const alex = await person(browser, "Alex Rivera");
  const pedro = await person(browser, "Pedro Chen");
  const agustin = await person(
    browser,
    "Agustin Park with a longer display name",
    "hiring",
  );
  const pedroPurpose = "Explore a technical cofounder opportunity with Pedro.";
  const agustinPurpose = "Discuss Agustin's founding engineer hiring plans.";
  try {
    await alex.page.goto("/network");
    await view(alex.page, "Agents");
    await expect(
      alex.page.getByRole("heading", { name: "No agent conversations yet" }),
    ).toBeVisible();
    await alex.page.getByRole("button", { name: "Find your people" }).click();
    await expect(
      alex.page.getByRole("heading", { name: "Your people", exact: true }),
    ).toBeVisible();
    await connect(alex, pedro);
    await connect(alex, agustin);
    const { qrToken: _qr, ...pedroSettings } = pedro.state.settings;
    void _qr;
    const shared = await pedro.page.request.post("/api/network", {
      headers: { origin },
      data: {
        action: "settings",
        settings: {
          ...pedroSettings,
          visibility: { ...pedroSettings.visibility, profile: "friends" },
        },
      },
    });
    expect(shared.status()).toBe(200);
    for (const [target, purpose] of [
      [pedro, pedroPurpose],
      [agustin, agustinPurpose],
    ] as const) {
      const sent = await alex.page.request.post("/api/network", {
        headers: { origin },
        data: {
          action: "query",
          toUserId: target.account.id,
          purpose,
          fields: ["profile"],
          requestId: crypto.randomUUID(),
        },
      });
      expect(sent.status()).toBe(200);
    }
    await alex.page.goto("/network");
    const navigation = alex.page.getByRole("navigation", {
      name: "Network views",
    });
    await navigation
      .getByRole("button", { name: "For you", exact: true })
      .focus();
    await alex.page.keyboard.press("Tab");
    await expect(
      navigation.getByRole("button", { name: /^Agents/ }),
    ).toBeFocused();
    await alex.page.keyboard.press("Enter");
    const pedroThread = alex.page.getByRole("button", {
      name: "Open agent conversation with Pedro Chen",
      exact: true,
    });
    await pedroThread.focus();
    await alex.page.keyboard.press("Enter");
    const conversation = alex.page.getByRole("region", {
      name: "Conversation with Pedro Chen",
      exact: true,
    });
    await expect(
      conversation.getByText(pedroPurpose, { exact: true }),
    ).toBeVisible();
    await expect(
      conversation.getByText(agustinPurpose, { exact: true }),
    ).toHaveCount(0);
    await expect(
      conversation.getByText("Your Sidekick → Pedro’s Sidekick", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      conversation.getByText("Shared a reply", { exact: true }),
    ).toBeVisible();
    await expect(
      conversation.getByText(
        "Pedro Chen builds AI agents and TypeScript software in production. Private project: Orchard.",
        { exact: false },
      ),
    ).toBeVisible();
    const state = await (await alex.page.request.get("/api/network")).json();
    const exchange = state.messages.find(
      (message: { toUserId: string }) => message.toUserId === pedro.account.id,
    );
    const expectedTimes = exchange.activity
      .map((entry: { at: string }) => entry.at)
      .sort();
    expect(expectedTimes.length).toBeGreaterThanOrEqual(2);
    const history = conversation.getByRole("list", {
      name: "Agent exchange history",
    });
    await expect
      .poll(() =>
        history
          .locator("time")
          .evaluateAll((times) =>
            times.map((time) => time.getAttribute("datetime")),
          ),
      )
      .toEqual(expectedTimes);
    for (const time of await history.locator("time").all()) {
      await expect(time).toBeVisible();
      await expect(time).toContainText(/\d+:\d{2}/);
    }
    await alex.page.reload();
    await expect(conversation).toBeVisible();
    await expect(
      history.getByText(pedroPurpose, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        history
          .locator("time")
          .evaluateAll((times) =>
            times.map((time) => time.getAttribute("datetime")),
          ),
      )
      .toEqual(expectedTimes);
    await shot(alex.page, "agent-conversation-mobile");
    await alex.page
      .getByRole("button", { name: "All conversations", exact: false })
      .focus();
    await alex.page.keyboard.press("Enter");
    const agustinThread = alex.page.getByRole("button", {
      name: "Open agent conversation with Agustin Park with a longer display name",
      exact: true,
    });
    await agustinThread.focus();
    await alex.page.keyboard.press("Enter");
    const otherConversation = alex.page.getByRole("region", {
      name: "Conversation with Agustin Park with a longer display name",
      exact: true,
    });
    await expect(
      otherConversation.getByText(agustinPurpose, { exact: true }),
    ).toBeVisible();
    await expect(
      otherConversation.getByText(pedroPurpose, { exact: true }),
    ).toHaveCount(0);
    await expect(
      otherConversation.getByText(
        "Waiting for Agustin to decide what to share.",
        { exact: true },
      ),
    ).toBeVisible();
    for (const width of [320, 390, 1280]) {
      await alex.page.setViewportSize({ width, height: 900 });
      expect(
        await alex.page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await expect(otherConversation).toBeVisible();
      await shot(alex.page, `agent-conversation-${width}`);
    }
  } finally {
    await alex.context.close();
    await pedro.context.close();
    await agustin.context.close();
  }
});
