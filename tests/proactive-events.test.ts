import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PROACTIVE_EVENT_LIMITS, emptyCoverage, validateCandidate, type Recommendation } from "@/lib/domain/event-discovery";
import { draftFromContext } from "@/lib/domain/onboarding-chat";
import { ContextStore } from "@/lib/server/store";
import { discoveryStatus, drainEventDiscovery, startDiscovery, type DiscoveryDeps } from "@/lib/server/event-discovery-service";
import { GET as cron } from "@/app/api/cron/events/route";
import { discoveryNow, eventFixture } from "./discovery-fixtures";
import { validContext } from "./fixtures";

let store: ContextStore, folder: string, path: string, now: Date;
const stores: ContextStore[] = [];
const request = (revision = 1) => ({ action: "refresh" as const, revision, requestId: crypto.randomUUID() });
async function account() {
  const login = await store.continueAccount(`${crypto.randomUUID()}@example.test`);
  await store.save(login.token, { context: validContext(), baseRevision: 0, requestId: crypto.randomUUID() });
  return { ...login, owner: await store.calendarOwner(login.token) };
}
function deps(): DiscoveryDeps {
  const fixture = eventFixture();
  return {
    now: () => now,
    plan: vi.fn<DiscoveryDeps["plan"]>(async () => ({ topics: ["ai_agents"], audiences: ["builders"], formats: ["meetup"], avoid: [] })),
    search: vi.fn<DiscoveryDeps["search"]>(async (query) => query.includeDomains?.includes("luma.com")
      ? [{ url: fixture.candidate.url, title: fixture.candidate.title, text: fixture.candidate.texts[0] }] : []),
    contents: vi.fn(async () => ({ results: [], statuses: [] })),
    extract: vi.fn<DiscoveryDeps["extract"]>(async (candidates) => candidates.map((candidate) => ({ ...fixture.extracted, candidateId: candidate.id }))),
    rank: vi.fn<DiscoveryDeps["rank"]>(async (_, candidates) => ({ picks: candidates.map((candidate) => ({
      candidateId: candidate.id, reason: "The builder format could help you meet small engineering teams.",
      evidenceQuote: candidate.description, caveat: null,
    })) })),
  };
}
function recommendation(slug = "builder-night"): Recommendation {
  const fixture = eventFixture();
  const candidate = { ...fixture.candidate, url: `https://luma.com/${slug}` };
  return { ...validateCandidate(candidate, fixture.extracted, validContext(), now)!, reason: "The builder format fits your engineering interests." };
}
async function result(token: string, events: Recommendation[], revision = 1) {
  const claim = await store.claimDiscovery(token, request(revision), now, true);
  expect(claim.claimed).toBe(true);
  await store.finishDiscovery(claim.owner, revision, claim.row.run_id, events.length ? "ready" : "empty", {
    recommendations: events, coverage: emptyCoverage(), checkedAt: now.toISOString(),
  }, emptyCoverage(), null, now);
}
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "fixture");
  vi.stubEnv("EXA_API_KEY", "fixture");
  vi.stubEnv("DISCOVERY_DAILY_RUN_LIMIT", "100");
  folder = mkdtempSync(join(tmpdir(), "sidekick-proactive-events-"));
  path = join(folder, "fixture.sqlite");
  store = new ContextStore(path);
  stores.push(store);
  now = discoveryNow();
});
afterEach(() => {
  for (const entry of stores.splice(0)) entry.close();
  rmSync(folder, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("checks every 15 minutes without rerunning research or posting chat messages, refreshing after six hours", async () => {
  const user = await account(), providers = deps();
  const before = await store.readChat(user.token);
  expect(await drainEventDiscovery(store, providers)).toMatchObject({ checked: 1, started: 1 });
  const first = await discoveryStatus(store, user.token, now);
  expect(first.suggestion).toMatchObject({ eventId: "event-1" });
  expect(await drainEventDiscovery(store, providers)).toMatchObject({ checked: 0, started: 0 });
  now = new Date(now.getTime() + PROACTIVE_EVENT_LIMITS.checkMs);
  expect(await drainEventDiscovery(store, providers)).toMatchObject({ checked: 1, started: 0 });
  expect((await discoveryStatus(store, user.token, now)).suggestion).toEqual(first.suggestion);
  expect(providers.search).toHaveBeenCalledTimes(4);
  now = new Date(discoveryNow().getTime() + PROACTIVE_EVENT_LIMITS.refreshMs);
  expect(await drainEventDiscovery(store, providers)).toMatchObject({ checked: 1, started: 1 });
  expect(providers.search).toHaveBeenCalledTimes(8);
  expect((await discoveryStatus(store, user.token, now)).suggestion).toBeNull();
  expect(await store.readChat(user.token)).toEqual(before);
});

it("claims fairly and atomically across clients without creating or requiring a login", async () => {
  const a = await account(), b = await account();
  await store.logout(a.token);
  await store.logout(b.token);
  const second = new ContextStore(path);
  stores.push(second);
  const claims = await Promise.all([store.claimProactiveDiscoveryCheck(now), second.claimProactiveDiscoveryCheck(now)]);
  expect(new Set(claims.map((claim) => claim!.owner))).toEqual(new Set([a.owner, b.owner]));
  expect(await second.claimProactiveDiscoveryCheck(now)).toBeNull();
  now = new Date(now.getTime() + PROACTIVE_EVENT_LIMITS.checkMs);
  expect(await second.claimProactiveDiscoveryCheck(now)).not.toBeNull();
  expect(await store.db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toMatchObject({ count: 0 });
});

it("checks a bounded batch of cached profiles before starting at most one new pipeline", async () => {
  const users = await Promise.all(Array.from({ length: PROACTIVE_EVENT_LIMITS.checksPerRun + 2 }, () => account()));
  users.sort((a, b) => a.owner.localeCompare(b.owner));
  for (const user of users.slice(0, PROACTIVE_EVENT_LIMITS.checksPerRun))
    await result(user.token, [recommendation()]);
  const providers = deps();
  expect(await drainEventDiscovery(store, providers)).toEqual({
    configured: true, checked: PROACTIVE_EVENT_LIMITS.checksPerRun, started: 0,
  });
  expect(providers.plan).not.toHaveBeenCalled();
  expect(await drainEventDiscovery(store, providers)).toEqual({ configured: true, checked: 1, started: 1 });
  expect(providers.plan).toHaveBeenCalledTimes(1);
  expect(await store.readDiscovery(users.at(-1)!.token, now)).toBeNull();
  expect(await drainEventDiscovery(store, providers)).toEqual({ configured: true, checked: 1, started: 1 });
  expect(providers.plan).toHaveBeenCalledTimes(2);
});

it("passes fresh cached profiles in the same invocation to reach the next user needing research", async () => {
  const users = await Promise.all(Array.from({ length: 4 }, () => account()));
  users.sort((a, b) => a.owner.localeCompare(b.owner));
  for (const user of users.slice(0, 2)) await result(user.token, [recommendation()]);
  const providers = deps();
  expect(await drainEventDiscovery(store, providers)).toEqual({ configured: true, checked: 3, started: 1 });
  expect(providers.plan).toHaveBeenCalledTimes(1);
  expect((await store.readDiscovery(users[2].token, now))?.status).toBe("ready");
  expect(await store.readDiscovery(users[3].token, now)).toBeNull();
});

it("only selects confirmed registered users with future SF trips and no unsaved draft", async () => {
  const a = await account();
  const context = validContext();
  context.goal.text = "Meet robotics teams to explore a founding engineer role";
  const chat = await store.readChat(a.token);
  await store.commitChat(a.token, { action: "message", revision: chat.revision, requestId: crypto.randomUUID(), message: "Change my goal" }, {
    reply: "Review your updated goal.", profileGaps: [], draft: draftFromContext(context),
  });
  const anonymous = await store.ensureSession();
  await store.save(anonymous.token, { context: validContext(), baseRevision: 0, requestId: crypto.randomUUID() });
  await store.continueAccount("unconfirmed@example.test");
  expect(await store.claimProactiveDiscoveryCheck(now)).toBeNull();
  const draft = await store.readChat(a.token);
  await store.commitChat(a.token, { action: "confirm", revision: draft.revision, requestId: crypto.randomUUID() });
  expect(await store.claimProactiveDiscoveryCheck(now)).toMatchObject({ owner: a.owner, revision: 2 });
  now = new Date("2026-11-06T18:00:00Z");
  expect(await store.claimProactiveDiscoveryCheck(now)).toBeNull();
});

it("dismissal is idempotent, account-scoped, revision-checked and persists across restart", async () => {
  const a = await account(), b = await account();
  await result(a.token, [recommendation()]);
  const suggestion = (await store.eventSuggestion(a.owner, now, true))!;
  await store.dismissEventSuggestion(b.token, 1, suggestion.id, now);
  expect(await store.eventSuggestion(a.owner, now)).toEqual(suggestion);
  await expect(store.dismissEventSuggestion(a.token, 2, suggestion.id, now)).rejects.toThrow("profile_changed");
  await Promise.all([
    store.dismissEventSuggestion(a.token, 1, suggestion.id, now),
    store.dismissEventSuggestion(a.token, 1, suggestion.id, now),
  ]);
  const restored = new ContextStore(path);
  stores.push(restored);
  expect(await restored.eventSuggestion(a.owner, now, true)).toBeNull();
  now = new Date(now.getTime() + PROACTIVE_EVENT_LIMITS.suggestionMs);
  await result(a.token, [recommendation()]);
  expect(await restored.eventSuggestion(a.owner, now, true)).toBeNull();
});

it("limits new suggestions to one at a time, six hours apart and two per SF day", async () => {
  const user = await account();
  now = new Date("2026-10-24T15:00:00Z"); // 8 AM in SF.
  await result(user.token, [recommendation("first"), recommendation("second")]);
  const first = (await store.eventSuggestion(user.owner, now, true))!;
  expect(await store.eventSuggestion(user.owner, now, true)).toEqual(first);
  await store.dismissEventSuggestion(user.token, 1, first.id, now);
  expect(await store.eventSuggestion(user.owner, now, true)).toBeNull();
  now = new Date("2026-10-24T21:00:00Z");
  await result(user.token, [recommendation("second")]);
  const second = (await store.eventSuggestion(user.owner, now, true))!;
  expect(second.id).not.toBe(first.id);
  await store.dismissEventSuggestion(user.token, 1, second.id, now);
  now = new Date("2026-10-25T03:00:00Z"); // Still October 24 in SF.
  await result(user.token, [recommendation("third")]);
  expect(await store.eventSuggestion(user.owner, now, true)).toBeNull();
  now = new Date("2026-10-25T15:00:00Z");
  await result(user.token, [recommendation("third")]);
  expect(await store.eventSuggestion(user.owner, now, true)).not.toBeNull();
});

it("keeps automatic work quiet at night while allowing an explicit search", async () => {
  const user = await account(), providers = deps();
  now = new Date("2026-10-25T06:00:00Z"); // 11 PM in SF.
  expect(await drainEventDiscovery(store, providers)).toMatchObject({ checked: 1, started: 0 });
  expect(providers.plan).not.toHaveBeenCalled();
  const started = await startDiscovery(store, user.token, request(), providers);
  await started.run?.();
  expect((await discoveryStatus(store, user.token, now)).suggestion).not.toBeNull();
});

it("does not promote stale, expired or newly private draft context", async () => {
  const user = await account();
  await result(user.token, [recommendation()]);
  expect(await store.eventSuggestion(user.owner, now, true)).not.toBeNull();
  const context = validContext();
  context.goal.text = "Find collaborators for a new private project";
  const chat = await store.readChat(user.token);
  await store.commitChat(user.token, { action: "message", revision: chat.revision, requestId: crypto.randomUUID(), message: "Change my goal" }, {
    reply: "Review the change.", profileGaps: [], draft: draftFromContext(context),
  });
  expect(await store.eventSuggestion(user.owner, now, true)).toBeNull();
  const draft = await store.readChat(user.token);
  await store.commitChat(user.token, { action: "confirm", revision: draft.revision, requestId: crypto.randomUUID() });
  expect((await discoveryStatus(store, user.token, now)).suggestion).toBeNull();
  await result(user.token, [recommendation("new-goal")], 2);
  now = new Date(now.getTime() + PROACTIVE_EVENT_LIMITS.refreshMs);
  expect(await store.eventSuggestion(user.owner, now, true)).toBeNull();
});

it("suppresses registered canonical aliases without mistaking reused recommendation IDs for the same event", async () => {
  const user = await account();
  await store.db.prepare("INSERT INTO network_events (id, user_id, event_json, updated_at) VALUES (?, ?, ?, ?)").run(
    crypto.randomUUID(), user.account.id, JSON.stringify({ attendance: "registered", sourceRecommendationId: "event-1", url: "https://lu.ma/builder-night?utm_source=fixture", date: "2026-11-05" }), now.toISOString(),
  );
  await result(user.token, [recommendation()]);
  expect(await store.eventSuggestion(user.owner, now, true)).toBeNull();
  await result(user.token, [recommendation("different-event")]);
  expect(await store.eventSuggestion(user.owner, now, true)).not.toBeNull();
  await store.db.prepare("UPDATE network_events SET event_json = ? WHERE user_id = ?").run(
    JSON.stringify({ attendance: "registered", url: "https://luma.com/different-event", date: "2026-11-05" }), user.account.id,
  );
  expect(await store.eventSuggestion(user.owner, now)).toBeNull();
});

it("does not resuggest a registration when only its other platform listing is discovered later", async () => {
  const user = await account();
  await store.db.prepare("INSERT INTO network_events (id, user_id, event_json, updated_at) VALUES (?, ?, ?, ?)").run(
    crypto.randomUUID(), user.account.id, JSON.stringify({
      attendance: "registered", url: "https://eventbrite.com/e/builder-night-99999",
      aliasUrls: ["https://luma.com/builder-night"], date: "2026-11-05",
    }), now.toISOString(),
  );
  await result(user.token, [recommendation()]);
  expect(await store.eventSuggestion(user.owner, now, true)).toBeNull();
});

it("remaps reordered candidate IDs and never binds a suggestion to an outdated snapshot", async () => {
  const user = await account();
  const first = recommendation("first");
  await result(user.token, [first]);
  const oldRow = (await store.readDiscovery(user.token, now))!;
  const initial = (await store.eventSuggestion(user.owner, now, true))!;
  now = new Date(now.getTime() + 60_000);
  await result(user.token, [recommendation("different"), { ...first, id: "event-2" }]);
  expect(await store.eventSuggestion(user.owner, now)).toMatchObject({ id: initial.id, eventId: "event-2" });
  expect(await store.eventSuggestion(user.owner, now, false, false, oldRow.run_id)).toBeNull();
  await store.dismissEventSuggestion(user.token, 1, initial.id, now);
  now = new Date(now.getTime() + PROACTIVE_EVENT_LIMITS.suggestionMs);
  await result(user.token, [{ ...first, id: "event-3", url: "https://lu.ma/first?utm_source=fixture" }]);
  expect(await store.eventSuggestion(user.owner, now, true)).toBeNull();
});

it("keeps a fresh active suggestion through an explicit refresh and serializes simultaneous publication", async () => {
  const user = await account();
  await result(user.token, [recommendation()]);
  const second = new ContextStore(path);
  stores.push(second);
  const [a, b] = await Promise.all([
    store.eventSuggestion(user.owner, now, true),
    second.eventSuggestion(user.owner, now, true),
  ]);
  expect(a).not.toBeNull();
  expect(a).toEqual(b);
  const started = await startDiscovery(store, user.token, request(), deps());
  expect(started.view.suggestion).toEqual(a);
  await started.run?.();
  expect((await discoveryStatus(store, user.token, now)).suggestion).toEqual(a);
  const ledger = await store.db.prepare("SELECT result_json FROM runs WHERE session_id = ? AND operation_key = 'event-suggestions'").get(user.owner);
  expect(JSON.parse(String(ledger!.result_json)).dayCount).toBe(1);
});

it("retains honest failed source state and bounds outage retries", async () => {
  const user = await account(), providers = deps();
  await drainEventDiscovery(store, providers);
  const checkedAt = (await discoveryStatus(store, user.token, now)).discovery!.checkedAt;
  now = new Date(now.getTime() + PROACTIVE_EVENT_LIMITS.refreshMs);
  providers.plan = vi.fn(async () => { throw new Error("Fixture provider outage"); });
  await drainEventDiscovery(store, providers);
  expect(await discoveryStatus(store, user.token, now)).toMatchObject({
    suggestion: null, discovery: { status: "failed", errorCode: "planner_failed", checkedAt },
  });
  now = new Date(now.getTime() + PROACTIVE_EVENT_LIMITS.checkMs);
  expect(await drainEventDiscovery(store, providers)).toMatchObject({ started: 0 });
  expect(providers.plan).toHaveBeenCalledTimes(1);
});

it("shares the global daily and in-flight limits with explicit discovery", async () => {
  vi.stubEnv("DISCOVERY_DAILY_RUN_LIMIT", "1");
  await account();
  await account();
  const providers = deps();
  expect((await drainEventDiscovery(store, providers)).started).toBe(1);
  expect((await drainEventDiscovery(store, providers)).started).toBe(0);
  expect(providers.plan).toHaveBeenCalledTimes(1);
  vi.stubEnv("DISCOVERY_DAILY_RUN_LIMIT", "100");
  const users = await Promise.all(Array.from({ length: 4 }, () => account()));
  await Promise.all(users.slice(0, 3).map((user) => store.claimDiscovery(user.token, request(), now, true)));
  await drainEventDiscovery(store, providers);
  expect(providers.plan).toHaveBeenCalledTimes(1);
  expect((await store.readDiscovery(users[3].token, now))).toBeNull();
});

it("does not claim provider success without configuration and rejects unauthenticated cron requests", async () => {
  await account();
  vi.stubEnv("EXA_API_KEY", "");
  const providers = deps();
  expect(await drainEventDiscovery(store, providers)).toEqual({ configured: false, checked: 0, started: 0 });
  expect(providers.plan).not.toHaveBeenCalled();
  vi.stubEnv("CRON_SECRET", "fixture-secret");
  for (const header of [undefined, "Bearer wrong", "Bearer éééééééééééééé"])
    expect((await cron(new Request("https://sidekick.example.test/api/cron/events", {
      headers: header ? { authorization: header } : {},
    }))).status).toBe(401);
});
