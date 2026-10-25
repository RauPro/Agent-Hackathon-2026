import { test, expect, type Browser, type Page, type APIRequestContext } from "@playwright/test";
import { Temporal } from "@js-temporal/polyfill";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { validContext } from "../fixtures";
import { register } from "./auth-helper";

const origin = "http://127.0.0.1:3100";
test.use({ actionTimeout: 15000 });
const googleFixture = "http://127.0.0.1:3102/test/state";
function tripDates() {
  let start = Temporal.Now.plainDateISO("America/Los_Angeles").add({ days: 2 });
  while (start.dayOfWeek > 5) start = start.add({ days: 1 });
  return { start: start.toString(), end: start.add({ days: 7 }).toString() };
}
function at(date: string, time: string) {
  return Temporal.PlainDate.from(date).toZonedDateTime({ timeZone: "America/Los_Angeles", plainTime: time }).toInstant().toString();
}
async function person(browser: Browser, name: string, stay?: ReturnType<typeof validContext>["stay"]) {
  const context = await browser.newContext({ baseURL: origin, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const { account, email } = await register(page.request);
  const profile = validContext();
  profile.profile.name = name;
  if (stay) profile.stay = stay;
  Object.assign(profile.trip, tripDates());
  const saved = await page.request.post("/api/context", { headers: { origin }, data: { context: profile, baseRevision: 0, requestId: crypto.randomUUID(), confirmed: true } });
  expect(saved.status()).toBe(200);
  const network = await (await page.request.get("/api/network")).json();
  return { context, page, account, email, profile, network };
}
type Person = Awaited<ReturnType<typeof person>>;
async function connect(a: Person, b: Person) {
  expect((await a.page.request.post("/api/network", { headers: { origin }, data: { action: "connect", toUserId: b.account.id, source: "qr", token: b.network.settings.qrToken, context: "Met at a test-only workshop." } })).status()).toBe(200);
  expect((await b.page.request.post("/api/network", { headers: { origin }, data: { action: "connection", toUserId: a.account.id, decision: "accept" } })).status()).toBe(200);
}
async function google(page: Page) {
  const result = await page.request.post("/api/calendar/connect", { headers: { origin } });
  expect(result.status()).toBe(200);
  await page.goto((await result.json()).url);
  await page.getByRole("link", { name: "Allow test calendar", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/onboarding`);
}
async function sharedEvent(a: Person, b: Person) {
  for (const person of [a, b]) {
    const network = await (await person.page.request.get("/api/network")).json();
    expect((await person.page.request.post("/api/network", { headers: { origin }, data: { action: "settings", settings: { ...network.settings, qrToken: undefined, visibility: { ...network.settings.visibility, events: "friends" } } } })).status()).toBe(200);
    expect((await person.page.request.post("/api/network", { headers: { origin }, data: { action: "event", event: {
      title: "Test-only AI Builders Workshop", url: "https://example.com/test/meeting-workshop", area: "Downtown SF", visibility: "friends", attendance: "registered",
      start: at(a.profile.trip.start, "10:00"), end: at(a.profile.trip.start, "11:00"),
    } } })).status()).toBe(200);
  }
}
async function conversation(person: Person, other: Person) {
  await person.page.goto(`/network?view=agents&person=${other.account.id}`);
  await expect(person.page.getByRole("region", { name: `Conversation with ${other.profile.profile.name}`, exact: true })).toBeVisible();
}
async function meeting(request: APIRequestContext) {
  const result = await (await request.get("/api/meetings/chat")).json();
  expect(result.meetings).toHaveLength(1);
  return result.meetings[0];
}
async function propose(a: Person, b: Person) {
  await conversation(a, b);
  await a.page.locator("summary").filter({ hasText: "Coordinate a meeting" }).click();
  await a.page.getByLabel("What would you like to discuss?").fill("Compare our AI production experience after the shared workshop.");
  await a.page.getByRole("combobox", { name: /^Meet/ }).selectOption("online");
  await a.page.getByRole("button", { name: "Coordinate meeting", exact: true }).click();
  await expect.poll(async () => (await meeting(a.page.request)).modality).toBe("online");
}
async function shots(page: Page, name: string, widths = [320, 390, 1280]) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.PREVIEW_DIR) {
      await mkdir(process.env.PREVIEW_DIR, { recursive: true });
      if (name === "meeting-google-confirmed") await page.getByRole("link", { name: "Join Google Meet" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(process.env.PREVIEW_DIR, `${name}-${width}-simulated.png`), fullPage: true });
    }
  }
}

test.beforeEach(async ({ request }) => {
  await request.post(googleFixture, { data: { reset: true } });
});
test.afterEach(async ({ request }) => {
  await request.post(googleFixture, { data: { reset: true } });
});

test("agents propose around a shared event, escalate missing calendar timing to chat, and require both approvals before sending Meet", async ({ browser, request }) => {
  test.setTimeout(120000);
  const alex = await person(browser, "Alex Meeting Demo");
  const maya = await person(browser, "Maya Meeting Demo");
  try {
    await connect(alex, maya);
    await sharedEvent(alex, maya);
    await request.post(googleFixture, { data: { busy: [{ start: at(alex.profile.trip.start, "10:00"), end: at(alex.profile.trip.start, "11:30") }] } });
    await google(alex.page);
    await propose(alex, maya);
    let current = await meeting(alex.page.request);
    expect(current.sharedEvent.title).toBe("Test-only AI Builders Workshop");
    expect(current.activity.some((item: { kind: string }) => item.kind === "agent_slots_proposed")).toBe(true);
    expect(current.approvedUserIds).toEqual([]);
    await maya.page.goto(`/onboarding?agents=0&meeting=${current.id}`);
    const question = maya.page.getByRole("article", { name: "Meeting with Alex Meeting Demo" });
    await expect(question.getByText(/What day and time/)).toBeVisible();
    await maya.page.getByLabel("Your message", { exact: true }).fill("On the first day of my stay, 11:30 AM to 1 PM works for me.");
    const before = await meeting(maya.page.request);
    await maya.page.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(question.getByRole("button", { name: "Check these times" })).toBeVisible();
    expect((await meeting(maya.page.request)).revision).toBe(before.revision);
    await question.getByRole("button", { name: "Check these times" }).click();
    await expect.poll(async () => (await meeting(maya.page.request)).status).toBe("options_ready");
    current = await meeting(maya.page.request);
    expect(Date.parse(current.options[0].start)).toBe(Date.parse(at(alex.profile.trip.start, "11:30")));
    expect(current.availabilitySource).toBe("mixed");
    expect(current.activity.some((item: { kind: string }) => item.kind === "agent_slots_checked")).toBe(true);
    await conversation(alex, maya);
    await alex.page.getByRole("button", { name: "Approve this time and place" }).first().click();
    await expect(alex.page.getByText("You approved this time. Waiting for your connection.")).toBeVisible();
    current = await meeting(alex.page.request);
    expect((await alex.page.request.post("/api/meetings", { headers: { origin }, data: { action: "publish", meetingId: current.id, revision: current.revision } })).status()).toBe(403);
    expect((await alex.page.request.get(`/api/meetings/${current.id}/invitation`)).status()).toBe(403);
    expect((await (await request.get(googleFixture)).json()).insertCount).toBe(0);
    await shots(alex.page, "meeting-one-approval");
    await conversation(maya, alex);
    await maya.page.getByRole("button", { name: "Approve this time and place" }).first().click();
    await expect(maya.page.getByText("Both people approved", { exact: true })).toBeVisible();
    await conversation(alex, maya);
    await expect(alex.page.getByRole("link", { name: "Download calendar file" })).toBeVisible();
    await alex.page.getByRole("button", { name: "Allow calendar invitations" }).click();
    await expect(alex.page.getByRole("heading", { name: "Simulated Google consent" })).toBeVisible();
    await alex.page.getByRole("link", { name: "Allow test calendar", exact: true }).click();
    await expect(alex.page).toHaveURL(new RegExp(`/onboarding\\?agents=1&person=${maya.account.id}`));
    await expect(alex.page.getByRole("button", { name: "Send invitation with Google Meet" })).toBeEnabled();
    expect((await (await request.get(googleFixture)).json()).insertCount).toBe(0);
    await request.post(googleFixture, { data: { conferencePending: true } });
    await alex.page.getByRole("button", { name: "Send invitation with Google Meet" }).click();
    await expect(alex.page.getByText("The calendar invitation exists. Google is still preparing the Meet link.")).toBeVisible();
    expect((await (await request.get(googleFixture)).json()).insertCount).toBe(1);
    await expect(alex.page.getByRole("link", { name: "Join Google Meet" })).toHaveCount(0);
    await request.post(googleFixture, { data: { conferencePending: false } });
    await alex.page.getByRole("button", { name: "Check calendar invitation" }).click();
    await expect(alex.page.getByRole("link", { name: "Join Google Meet" })).toHaveAttribute("href", "https://meet.google.com/fixture-only-demo");
    await shots(alex.page, "meeting-google-confirmed");
    await conversation(maya, alex);
    await expect(maya.page.getByText("Calendar invitation sent.")).toBeVisible();
    await expect(maya.page.getByRole("link", { name: "Join Google Meet" })).toBeVisible();
    current = await meeting(maya.page.request);
    expect(current.calendarPublication).not.toHaveProperty("calendarId");
    expect((await maya.page.request.post("/api/meetings", { headers: { origin }, data: { action: "publish", meetingId: current.id, revision: current.revision } })).status()).toBe(200);
    const provider = await (await request.get(googleFixture)).json();
    expect(provider.insertCount).toBe(1);
    expect(provider.events[0].attendees).toContainEqual({ email: maya.email });
  } finally { await alex.context.close(); await maya.context.close(); }
});

test("no common calendar window escalates into the main chat and a typed preference cannot override busy time", async ({ browser, request }) => {
  test.setTimeout(120000);
  const alex = await person(browser, "Alex Busy Demo");
  const maya = await person(browser, "Maya Busy Demo");
  try {
    await connect(alex, maya);
    await request.post(googleFixture, { data: { busy: [{ start: at(alex.profile.trip.start, "00:00"), end: at(alex.profile.trip.end, "23:59") }] } });
    await google(alex.page); await google(maya.page);
    await propose(alex, maya);
    let current = await meeting(alex.page.request);
    await maya.page.goto(`/onboarding?agents=0&meeting=${current.id}`);
    await maya.page.getByRole("button", { name: "Let my agent check my calendar" }).click();
    await expect.poll(async () => (await meeting(maya.page.request)).status).toBe("needs_user_input");
    current = await meeting(maya.page.request);
    expect(current.options).toEqual([]);
    expect(current.nextAction.kind).toBe("suggest_times");
    await maya.page.getByRole("button", { name: "Suggest a time", exact: true }).click();
    await maya.page.getByLabel("Your message", { exact: true }).fill("On the first day of my stay, 11 AM to 1 PM would be convenient.");
    await maya.page.getByRole("button", { name: "Send message", exact: true }).click();
    await maya.page.getByRole("button", { name: "Check these times" }).click();
    await expect.poll(async () => (await meeting(maya.page.request)).status).toBe("needs_user_input");
    current = await meeting(maya.page.request);
    expect(current.options).toEqual([]);
    expect(current.approvedUserIds).toEqual([]);
    expect(current.ownPreferredWindows).toHaveLength(1);
    expect((await (await request.get(googleFixture)).json()).insertCount).toBe(0);
    await shots(maya.page, "meeting-no-common-time");
  } finally { await alex.context.close(); await maya.context.close(); }
});

test("a private hotel helps its owner find a public place without being shared in the meeting", async ({ browser }) => {
  const alex = await person(browser, "Alex Stay Demo", { status: "provided", hotel: "Fictional Harbor Hotel — test only", area: "SoMa" });
  const maya = await person(browser, "Maya Stay Demo");
  try {
    await connect(alex, maya);
    await alex.page.goto("/onboarding");
    await alex.page.locator("summary").filter({ hasText: "Profile" }).click();
    await expect(alex.page.getByText("Stay · private", { exact: true })).toBeVisible();
    await expect(alex.page.getByText("Fictional Harbor Hotel — test only", { exact: true })).toBeVisible();
    await shots(alex.page, "meeting-private-stay");
    const beforeDiscovery = await (await alex.page.request.get("/api/network")).json();
    await alex.page.getByRole("button", { name: "Enable people discovery", exact: true }).click();
    await expect.poll(async () => (await (await alex.page.request.get("/api/network")).json()).settings.discoverable).toBe(true);
    const afterDiscovery = await (await alex.page.request.get("/api/network")).json();
    expect(afterDiscovery.settings.visibility).toMatchObject({ profile: "network", goal: "network", trip: "network", events: beforeDiscovery.settings.visibility.events });
    expect(afterDiscovery.settings.area).toBeNull();
    expect((await (await alex.page.request.get("/api/state")).json()).context.stay).toEqual({ status: "provided", hotel: "Fictional Harbor Hotel — test only", area: "SoMa" });
    await conversation(alex, maya);
    await alex.page.locator("summary").filter({ hasText: "Coordinate a meeting" }).click();
    const nearby = alex.page.getByRole("link", { name: "Find a café or restaurant" });
    await expect(nearby).toHaveAttribute("href", /SoMa/);
    expect(await nearby.getAttribute("href")).not.toContain("Harbor");
    await expect(alex.page.getByRole("checkbox", { name: "Share SoMa as a convenient area for this meeting" })).not.toBeChecked();
    await alex.page.getByLabel("What would you like to discuss?").fill("Compare AI infrastructure projects over a coffee.");
    await shots(alex.page, "meeting-nearby-public-place");
    await alex.page.getByRole("button", { name: "Coordinate meeting", exact: true }).click();
    await expect.poll(async () => (await meeting(alex.page.request)).purpose).toContain("coffee");
    const peer = await meeting(maya.page.request);
    expect(peer.sharedArea).toBeNull();
    expect(peer.suggestedArea).toBeNull();
    expect(peer.location).toBeNull();
    expect(JSON.stringify(peer)).not.toMatch(/Harbor Hotel|SoMa/);
  } finally { await alex.context.close(); await maya.context.close(); }
});
