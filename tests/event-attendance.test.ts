import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as stores from "../src/lib/server/store";
import { ContextStore } from "../src/lib/server/store";
import { DiscoveryService, registerEventAttendance } from "../src/lib/server/discovery-service";
import { AgentDialogueService } from "../src/lib/server/agent-dialogue-service";
import { completeAgentDialogue } from "../src/lib/server/agent-dialogue-model";
import { emptyCoverage, type Recommendation } from "../src/lib/domain/event-discovery";
import { canonicalEventUrl, type EventAttendanceInput } from "../src/lib/domain/discovery";
import { GET, POST } from "../src/app/api/events/attendance/route";
import { SESSION_COOKIE } from "../src/lib/server/http";
import { validContext } from "./fixtures";

vi.mock("next/server", async (original) => ({
  ...await original<typeof import("next/server")>(),
  after: vi.fn(),
}));
const now = new Date("2026-10-24T18:00:00Z");
let folder: string, store: ContextStore, service: DiscoveryService;
type Person = { id: string; token: string };
let a: Person, b: Person;
const shared = { profile: "network", goal: "network", trip: "network", events: "network" } as const;
function recommendation(changes: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "recommendation-1", title: "AI Builder Night", url: "https://luma.com/builder-night",
    platform: "luma", alsoListed: [], date: "2026-11-05", dateStatus: "confirmed",
    startTime: "18:00", endTime: null, timeZoneStated: true,
    location: { city: "San Francisco", venue: null, address: null, visibility: "unknown" },
    price: { kind: "unknown", label: "Unknown" }, registration: "open",
    reason: "Meet people building production AI agents.", caveats: ["End time is unknown."],
    evidence: [], checkedAt: now.toISOString(), ...changes,
  };
}
async function person(): Promise<Person> {
  const account = await store.registerAccount(`${randomUUID()}@example.test`, "fixture-hash");
  await store.save(account.token, { context: validContext(), baseRevision: 0, requestId: randomUUID() });
  return { id: account.account.id, token: account.token };
}
async function discoverable(person: Person) {
  const current = await store.network.settings(person.id);
  await store.network.saveSettings(person.id, {
    area: current.area, revision: current.revision, discoverable: true, visibility: shared });
}
async function snapshot(person: Person, event = recommendation(), checkedAt = now) {
  const revision = (await store.read(person.token))!.revision;
  const claim = await store.claimDiscovery(person.token, { action: "refresh", revision, requestId: randomUUID() }, now, true);
  if (!claim.claimed) throw new Error("Expected fixture discovery claim");
  await store.finishDiscovery(claim.owner, revision, claim.row.run_id, "ready",
    { recommendations: [event], coverage: emptyCoverage(), checkedAt: checkedAt.toISOString() },
    emptyCoverage(), null, now);
}
const registration = (changes: Partial<EventAttendanceInput> = {}): EventAttendanceInput => ({
  action: "register", recommendationId: "recommendation-1", discoveryCheckedAt: now.toISOString(),
  revision: 1, visibility: "network", ...changes,
});
const request = (person?: Person, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(
  "https://sidekick.example.test/api/events/attendance", {
    method: body ? "POST" : "GET", headers: {
      host: "sidekick.example.test", origin: "https://sidekick.example.test",
      "content-type": "application/json",
      ...(person && { cookie: `${SESSION_COOKIE}=${person.token}`, "x-sidekick-account": person.id }),
      ...headers,
    }, ...(body ? { body: JSON.stringify(body) } : {}),
  },
);
async function drain() {
  for (let i = 0; i < 30 && await service.drain(); i++);
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.spyOn(Temporal.Now, "plainDateISO").mockReturnValue(Temporal.PlainDate.from("2026-10-24"));
  vi.stubEnv("SIDEKICK_DEMO", "");
  folder = mkdtempSync(join(tmpdir(), "sidekick-attendance-"));
  store = new ContextStore(join(folder, "test.sqlite"));
  service = new DiscoveryService(store.network);
  vi.spyOn(stores, "getStore").mockReturnValue(store);
  a = await person(); b = await person();
});
afterEach(() => {
  store.close(); rmSync(folder, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe("reported event registration", () => {
  it("saves structured self-reported attendance without inventing an end time or widening global sharing", async () => {
    await snapshot(a);
    const response = await POST(request(a, registration()));
    expect(response.status).toBe(200);
    const { event, eventVisibility } = await response.json();
    expect(event).toMatchObject({ attendance: "registered", sourceMode: "user_report",
      reportedAt: now.toISOString(), sourceRecommendationId: "recommendation-1",
      date: "2026-11-05", dateStatus: "confirmed", start: "2026-11-06T02:00:00Z", end: null,
      visibility: "network" });
    expect(eventVisibility).toBe("private");
    await expect(store.network.project(b.id, a.id)).rejects.toMatchObject({ status: 403 });
    expect(await (await GET(request(a))).json()).toMatchObject({ events: [event], eventVisibility: "private" });
    expect(await (await GET(request(b))).json()).toMatchObject({ events: [] });
  });

  it("requires authentication, matching account identity, same origin, and a strict server-resolved reference", async () => {
    await snapshot(a);
    expect((await POST(request(undefined, registration()))).status).toBe(401);
    expect((await GET(request())).status).toBe(401);
    expect((await POST(request(a, registration(), { "x-sidekick-account": b.id }))).status).toBe(401);
    expect((await POST(request(a, registration(), { origin: "https://other.example.test" }))).status).toBe(403);
    expect((await POST(request(a, { ...registration(), title: "Injected", url: "https://other.example.com" }))).status).toBe(400);
    expect((await POST(request(b, registration()))).status).toBe(409);
    await snapshot(b, recommendation({ id: "other-recommendation" }));
    expect((await POST(request(b, registration()))).status).toBe(404);
    expect(await service.events(b.id)).toEqual([]);
  });

  it("rejects a changed profile, unknown recommendation, unconfirmed profile and past event", async () => {
    await snapshot(a);
    await expect(registerEventAttendance(store, a.token, registration({ recommendationId: "unknown" }), now))
      .rejects.toMatchObject({ code: "not_found" });
    const state = (await store.read(a.token))!;
    const context = structuredClone(state.context!); context.goal.text += " with TypeScript.";
    await store.save(a.token, { context, baseRevision: state.revision, requestId: randomUUID() });
    await expect(registerEventAttendance(store, a.token, registration(), now)).rejects.toMatchObject({ code: "stale_revision" });
    const draft = await store.registerAccount("draft@example.test", "fixture-hash");
    await expect(registerEventAttendance(store, draft.token, registration(), now)).rejects.toMatchObject({ code: "profile_missing" });
    await snapshot(b, recommendation({ date: "2026-10-23" }));
    await expect(registerEventAttendance(store, b.token, registration(), now)).rejects.toMatchObject({ code: "event_past" });
  });

  it("upgrades a manual record and deduplicates concurrent retries across clients by provider identity and SF date", async () => {
    const manual = await service.saveEvent(a.id, { title: "AI Builder Night", url: "https://lu.ma/builder-night?utm_source=friend",
      start: "2026-11-05T17:00:00-08:00", end: "2026-11-05T22:00:00-08:00", area: "SF", visibility: "private" });
    expect(manual.attendance).toBe("planned");
    await snapshot(a);
    const otherStore = new ContextStore(join(folder, "test.sqlite"));
    try {
      const [first, second] = await Promise.all([
        registerEventAttendance(store, a.token, registration(), now),
        registerEventAttendance(otherStore, a.token, registration(), now),
      ]);
      expect(first).toEqual(second);
      expect(first.id).toBe(manual.id);
      expect(first.end).toBeNull();
      expect(await service.events(a.id)).toHaveLength(1);
      const queued = await store.db.prepare("SELECT version FROM network_jobs WHERE user_id=?").get(a.id);
      await registerEventAttendance(store, a.token, registration(), new Date(now.getTime() + 60_000));
      expect(await store.db.prepare("SELECT version FROM network_jobs WHERE user_id=?").get(a.id)).toEqual(queued);
      expect((await service.events(a.id))[0].reportedAt).toBe(now.toISOString());
    } finally { otherStore.close(); }
  });

  it("rejects old positional recommendation IDs after a refresh of the same profile revision", async () => {
    await snapshot(a);
    const checkedAt = new Date(now.getTime() + 60_000);
    await snapshot(a, recommendation({ title: "Different Event", url: "https://luma.com/another-event" }), checkedAt);
    await expect(registerEventAttendance(store, a.token, registration(), checkedAt))
      .rejects.toMatchObject({ code: "stale_recommendation" });
    expect(await service.events(a.id)).toEqual([]);
    const saved = await registerEventAttendance(store, a.token,
      registration({ discoveryCheckedAt: checkedAt.toISOString() }), checkedAt);
    expect(saved.title).toBe("Different Event");
  });

  it("keeps unstated timezones unknown and normalizes legacy attendance as planned", async () => {
    await snapshot(a, recommendation({ timeZoneStated: false, startTime: "18:00", endTime: "20:00" }));
    const saved = await registerEventAttendance(store, a.token, registration(), now);
    expect(saved.start).toBeNull(); expect(saved.end).toBeNull();
    const legacy = { id: randomUUID(), title: "Legacy Plan", start: "2026-11-06T02:00:00Z",
      end: "2026-11-06T03:00:00Z", visibility: "private", sourceMode: "user_report" };
    await store.db.prepare("INSERT INTO network_events (id,user_id,event_json,updated_at) VALUES (?,?,?,?)")
      .run(legacy.id, a.id, JSON.stringify(legacy), now.toISOString());
    expect((await service.events(a.id)).find((event) => event.id === legacy.id))
      .toMatchObject({ attendance: "planned", date: "2026-11-05", dateStatus: "confirmed" });
  });

  it("does not carry a reported registration to a different event when a manual record is edited", async () => {
    await snapshot(a);
    const registered = await registerEventAttendance(store, a.token, registration(), now);
    const edited = await service.saveEvent(a.id, { id: registered.id, title: "Another Event",
      url: "https://luma.com/different-event", start: "2026-11-05T18:00:00-08:00",
      end: "2026-11-05T20:00:00-08:00", area: "SF", visibility: "network" });
    expect(edited.attendance).toBe("planned");
    expect(edited.sourceRecommendationId).toBeUndefined();
    expect(edited.sourceCheckedAt).toBeUndefined();
  });

  it("preserves uncertain years and missing start/end times without treating them as overlapping attendance", async () => {
    for (const p of [a, b]) {
      await discoverable(p);
      await snapshot(p, recommendation({ dateStatus: "unconfirmed_year", startTime: null, endTime: null }));
      const saved = await registerEventAttendance(store, p.token, registration(), now);
      expect(saved).toMatchObject({ date: "2026-11-05", dateStatus: "unconfirmed_year", start: null, end: null });
    }
    await drain();
    expect(await service.opportunities(a.id)).toEqual([]);
  });

  it("proposes a connection to same-event job seekers while keeping all agent conversations behind acceptance", async () => {
    for (const p of [a, b]) {
      await discoverable(p); await snapshot(p);
      await registerEventAttendance(store, p.token, registration(), now);
    }
    await drain();
    const opportunities = await service.opportunities(a.id);
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]).toMatchObject({ connected: false, sharedEvents: [{ attendance: "registered", end: null }] });
    expect(opportunities[0].reasons).toContain("Both reported registering for AI Builder Night.");
    expect(opportunities[0].benefits.you).not.toContain("hiring");
    expect(await new AgentDialogueService(store.network).list(a.id)).toEqual([]);
    expect(await store.network.messages(a.id)).toEqual([]);
    await store.network.requestConnection(a.id, b.id, { source: "opportunity", context: "Same event and shared interests." });
    await drain();
    expect(await new AgentDialogueService(store.network).list(a.id)).toEqual([]);
    await store.network.connectionAction(b.id, a.id, "accept");
    await drain();
    expect(await new AgentDialogueService(store.network).list(a.id)).toHaveLength(1);
  });

  it("matches validated cross-listed events with swapped primary links and keeps alias URLs private", async () => {
    const luma = { url: "https://luma.com/builder-night", platform: "luma" as const };
    const eventbrite = { url: "https://eventbrite.com/e/12345", platform: "eventbrite" as const };
    await discoverable(a); await discoverable(b);
    await snapshot(a, recommendation({ ...luma, alsoListed: [eventbrite] }));
    await snapshot(b, recommendation({ ...eventbrite, alsoListed: [luma] }));
    const first = await registerEventAttendance(store, a.token, registration(), now);
    const second = await registerEventAttendance(store, b.token, registration(), now);
    expect(first.canonicalKey).not.toBe(second.canonicalKey);
    expect(first.canonicalKeys).toEqual(second.canonicalKeys);
    expect(first.aliasUrls).toEqual([eventbrite.url]);
    const projection = await store.network.project(b.id, a.id);
    expect(projection.events![0].canonicalKeys).toHaveLength(2);
    expect(JSON.stringify(projection.events)).not.toContain("https://");
    await drain();
    const matches = await service.opportunities(a.id);
    expect(matches).toHaveLength(1);
    expect(matches[0].sharedEvents).toHaveLength(1);
    expect(matches[0].eventSuggestions).toEqual([]);
    expect(matches[0].reasons).toContain("Both reported registering for AI Builder Night.");
    expect(await new AgentDialogueService(store.network).list(a.id)).toEqual([]);
    const checkedAt = new Date(now.getTime() + 60_000);
    await snapshot(a, recommendation({ ...eventbrite }), checkedAt);
    const repeated = await registerEventAttendance(store, a.token,
      registration({ discoveryCheckedAt: checkedAt.toISOString() }), checkedAt);
    expect(repeated.id).toBe(first.id);
    expect(repeated.canonicalKeys).toEqual(first.canonicalKeys);
    expect(repeated.aliasUrls).toEqual([luma.url]);
    expect(await service.events(a.id)).toHaveLength(1);
  });

  it("does not infer cross-listing from titles or accept forged aliases in manual records", async () => {
    await discoverable(a); await discoverable(b);
    await snapshot(a);
    await snapshot(b, recommendation({ url: "https://eventbrite.com/e/99999", platform: "eventbrite" }));
    await registerEventAttendance(store, a.token, registration(), now);
    await registerEventAttendance(store, b.token, registration(), now);
    await drain();
    expect(await service.opportunities(a.id)).toEqual([]);
    const forged = {
      title: "AI Builder Night", url: "https://luma.com/unrelated", start: "2026-11-05T18:00:00-08:00",
      end: "2026-11-05T20:00:00-08:00", area: "SF", visibility: "network" as const,
      aliasUrls: ["https://eventbrite.com/e/99999"],
    };
    await expect(service.saveEvent(a.id, forged)).rejects.toThrow();
    const checkedAt = new Date(now.getTime() + 60_000);
    await snapshot(a, recommendation({ url: "https://eventbrite.com/e/99999", platform: "eventbrite" }), checkedAt);
    await registerEventAttendance(store, a.token, registration({ discoveryCheckedAt: checkedAt.toISOString() }), checkedAt);
    expect(await service.events(a.id)).toHaveLength(2);
  });

  it("keeps different dates of a cross-listed recurring event separate", async () => {
    await discoverable(a); await discoverable(b);
    const aliases = [{ url: "https://eventbrite.com/e/12345", platform: "eventbrite" as const }];
    await snapshot(a, recommendation({ date: "2026-11-04", alsoListed: aliases }));
    await snapshot(b, recommendation({ alsoListed: aliases }));
    await registerEventAttendance(store, a.token, registration(), now);
    await registerEventAttendance(store, b.token, registration(), now);
    await drain();
    expect(await service.opportunities(a.id)).toEqual([]);
    const checkedAt = new Date(now.getTime() + 60_000);
    await snapshot(a, recommendation({ alsoListed: aliases }), checkedAt);
    await registerEventAttendance(store, a.token, registration({ discoveryCheckedAt: checkedAt.toISOString() }), checkedAt);
    expect(await service.events(a.id)).toHaveLength(2);
  });

  it("respects opt-in, per-event visibility, global visibility and removal ownership", async () => {
    for (const p of [a, b]) { await snapshot(p); await registerEventAttendance(store, p.token, registration(), now); }
    await drain(); expect(await service.opportunities(a.id)).toEqual([]);
    await discoverable(a); await discoverable(b); await drain();
    const event = (await service.events(b.id))[0];
    await registerEventAttendance(store, b.token, registration({ visibility: "friends" }), now);
    expect((await store.network.project(a.id, b.id)).events).toEqual([]);
    expect(await service.opportunities(a.id)).toEqual([]);
    await registerEventAttendance(store, b.token, registration(), now);
    const prefs = await store.network.settings(b.id);
    await store.network.saveSettings(b.id, { discoverable: true, visibility: { ...shared, events: "private" },
      area: prefs.area, revision: prefs.revision });
    expect((await store.network.project(a.id, b.id)).events).toBeUndefined();
    expect(await service.sharedEvents(b.id, a.id)).toEqual([]);
    await service.removeEvent(a.id, event.id); expect(await service.events(b.id)).toHaveLength(1);
    await service.removeEvent(b.id, event.id); expect(await service.events(b.id)).toEqual([]);
  });

  it.each([
    ["https://lu.ma/builder-night?utm_source=a", "https://www.luma.com/builder-night?ref=b"],
    ["https://www.eventbrite.com/e/ai-builder-night-tickets-12345?aff=friend", "https://eventbrite.com/e/12345"],
    ["https://www.partiful.com/e/abc123?c=friend", "https://partiful.com/e/abc123"],
  ])("normalizes known provider aliases: %s", (first, second) => {
    expect(canonicalEventUrl(first)).toBe(canonicalEventUrl(second));
    expect(canonicalEventUrl("https://events.example.com/view?id=one"))
      .not.toBe(canonicalEventUrl("https://events.example.com/view?id=two"));
  });

  it("passes only authorized structured attendance and uncertainty to the agent model", async () => {
    await discoverable(a); await discoverable(b); await snapshot(a);
    await registerEventAttendance(store, a.token, registration(), now);
    const self = await store.network.project(b.id, a.id), peer = await store.network.project(a.id, b.id);
    Object.assign(self.events![0], { url: "https://private.example.com", calendar: "Secret calendar detail" });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "resp_test", object: "response", status: "completed", output: [{
        id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{
          type: "output_text", annotations: [], text: JSON.stringify({
            message: "They both build production AI systems. Which shared topic would help them exchange useful experience?",
            next: "continue", questionForUser: null, suggestedNextStep: null,
          }),
        }],
      }],
    }), { headers: { "content-type": "application/json" } }));
    vi.stubEnv("OPENAI_API_KEY", "fixture-key"); vi.stubGlobal("fetch", fetch);
    await completeAgentDialogue({ self, peer, history: [], turnNumber: 1, turnLimit: 6 });
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(JSON.parse(body.input[0].content).self.events[0]).toMatchObject({
      attendance: "registered", date: "2026-11-05", end: null, sourceMode: "user_report", reportedAt: now.toISOString(),
    });
    expect(body.instructions).toContain("not provider-verified admission");
    expect(JSON.stringify(body)).not.toContain("Secret calendar detail");
    expect(JSON.stringify(body)).not.toContain("private.example.com");
  });
});
