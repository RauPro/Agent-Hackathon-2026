import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_SCOPES, CALENDAR_WRITE_SCOPE, type CalendarConnection } from "../src/lib/domain/calendar";
import { sealCalendarData } from "../src/lib/server/calendar-crypto";
import { beginCalendarConnection, calendarStatus, finishCalendarConnection } from "../src/lib/server/calendar-service";
import { createOrGetGoogleMeeting, type GoogleMeetingInput } from "../src/lib/server/google-calendar";
import { prepareMeetingCalendar, publishApprovedMeeting, type ApprovedMeetingCalendarInput } from "../src/lib/server/meeting-calendar-service";
import { ContextStore } from "../src/lib/server/store";
import { validContext } from "./fixtures";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const providerInput: GoogleMeetingInput = {
  meetingId: "meeting-test", calendarId: "owner@example.test", eventId: "a".repeat(64),
  conferenceRequestId: "b".repeat(64), title: "Discuss a collaboration", location: null,
  start: "2026-11-04T19:30:00Z", end: "2026-11-04T20:00:00Z", online: true,
  attendees: ["friend@example.test"],
};
function event(input = providerInput, conferenceStatus: "success" | "pending" | "failure" = "success") {
  return {
    id: input.eventId, status: "confirmed", htmlLink: "https://calendar.google.com/calendar/event?eid=test",
    summary: input.title, ...(!input.online && input.location ? { location: input.location } : {}),
    attendees: input.attendees.map((email) => ({ email })),
    start: { dateTime: input.start }, end: { dateTime: input.end },
    extendedProperties: { private: { sidekickMeetingId: input.meetingId } },
    conferenceData: {
      createRequest: { status: { statusCode: conferenceStatus } },
      ...(conferenceStatus === "success" ? { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/abc-defg-hij" }] } : {}),
    },
  };
}

beforeEach(() => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
  vi.stubEnv("GOOGLE_REDIRECT_URI", "http://127.0.0.1:3000/api/calendar/callback");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Google meeting publication adapter", () => {
  it("creates one private event with a unique Meet request and explicit attendee notifications", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? reply(event()) : reply({}, 404));
    vi.stubGlobal("fetch", fetch);
    const result = await createOrGetGoogleMeeting("test-access", providerInput, AbortSignal.timeout(1000));
    expect(result.meetUrl).toBe("https://meet.google.com/abc-defg-hij");
    const [url, init] = fetch.mock.calls[1];
    expect(url).toContain("conferenceDataVersion=1");
    expect(url).toContain("sendUpdates=all");
    expect(JSON.parse(init!.body as string)).toMatchObject({
      id: providerInput.eventId, visibility: "private",
      attendees: [{ email: "friend@example.test" }],
      conferenceData: { createRequest: { requestId: providerInput.conferenceRequestId, conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
  });
  it("reconciles an existing event without sending another insert or invitation", async () => {
    const fetch = vi.fn(async () => reply(event()));
    vi.stubGlobal("fetch", fetch);
    await createOrGetGoogleMeeting("test-access", providerInput, AbortSignal.timeout(1000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.length).toBeGreaterThan(0);
  });
  it("reconciles a timeout after Google creates the event", async () => {
    let reads = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") throw new Error("network interrupted after insert");
      return ++reads === 1 ? reply({}, 404) : reply(event());
    });
    vi.stubGlobal("fetch", fetch);
    expect((await createOrGetGoogleMeeting("test-access", providerInput, AbortSignal.timeout(1000))).meetUrl).toBeTruthy();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("reports a pending Meet instead of inventing a video URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(event(providerInput, "pending"))));
    expect(await createOrGetGoogleMeeting("test-access", providerInput, AbortSignal.timeout(1000))).toMatchObject({ conferenceStatus: "pending", meetUrl: null });
  });
  it("does not recreate a cancelled event or overwrite an unrelated event", async () => {
    const fetch = vi.fn(async () => reply({ ...event(), status: "cancelled" }));
    vi.stubGlobal("fetch", fetch);
    await expect(createOrGetGoogleMeeting("test-access", providerInput, AbortSignal.timeout(1000))).rejects.toThrow("event_cancelled");
    fetch.mockImplementation(async () => reply({ ...event(), extendedProperties: {} }));
    await expect(createOrGetGoogleMeeting("test-access", providerInput, AbortSignal.timeout(1000))).rejects.toThrow("event_conflict");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("preserves provider failure without claiming that an invitation was sent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => reply({}, init?.method === "POST" ? 503 : 404)));
    await expect(createOrGetGoogleMeeting("test-access", providerInput, AbortSignal.timeout(1000))).rejects.toThrow("sync_failed");
  });
  it.each([
    { summary: "An unrelated meeting" },
    { location: "A different meeting place" },
    { attendees: [{ email: "unapproved@example.test" }] },
  ])("refuses a retry after the approved Google event changes: %j", async (changed) => {
    const fetch = vi.fn(async () => reply({ ...event(), ...changed }));
    vi.stubGlobal("fetch", fetch);
    await expect(createOrGetGoogleMeeting("test-access", providerInput, AbortSignal.timeout(1000))).rejects.toThrow("event_conflict");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("approved meeting calendar boundary", () => {
  let store: ContextStore;
  let a: Awaited<ReturnType<ContextStore["registerAccount"]>>, b: typeof a;
  let input: ApprovedMeetingCalendarInput;
  let state: Record<string, unknown>;
  async function writeState() {
    await store.network.db.prepare("UPDATE meetings SET state_json = ? WHERE id = ?").run(JSON.stringify(state), input.id);
  }
  async function attach(write = true) {
    const owner = await store.calendarOwner(a.token);
    const connection: CalendarConnection = {
      subject: "google-owner", email: "owner@example.test",
      encryptedTokens: sealCalendarData({ accessToken: "test-access", refreshToken: "test-refresh", expiresAt: Date.now() + 3600000, scopes: [...CALENDAR_SCOPES, ...(write ? [CALENDAR_WRITE_SCOPE] : [])] }, owner),
      calendars: [
        { id: "owner@example.test", name: "Personal", primary: true, timezone: "America/Los_Angeles" },
        { id: "work@example.test", name: "Work", primary: false, timezone: "America/Los_Angeles" },
      ], selectedIds: ["work@example.test"], snapshot: null, issue: null,
    };
    await store.writeCalendar(a.token, (await store.readCalendar(a.token)).revision, connection);
  }
  beforeEach(async () => {
    store = new ContextStore(":memory:");
    a = await store.registerAccount("owner@example.test", "unused");
    b = await store.registerAccount("friend@example.test", "unused");
    for (const account of [a, b]) await store.save(account.token, { context: validContext(), baseRevision: 0, requestId: randomUUID() });
    await store.network.requestConnection(a.account.id, b.account.id, { source: "qr", token: (await store.network.settings(b.account.id)).qrToken, context: "A test connection" });
    await store.network.connectionAction(b.account.id, a.account.id, "accept");
    input = { id: randomUUID(), purpose: "Discuss a collaboration", location: "Google Meet", modality: "online", participants: [a.account.id, b.account.id], names: { [a.account.id]: "Alex", [b.account.id]: "Blair" }, slot: { start: providerInput.start, end: providerInput.end } };
    state = { ...input, status: "confirmed", selectedOptionId: "chosen", options: [{ id: "chosen", ...input.slot }], approvals: { [a.account.id]: "chosen", [b.account.id]: "chosen" },
      contextRevisions: { [a.account.id]: (await store.network.profile(a.account.id)).revision, [b.account.id]: (await store.network.profile(b.account.id)).revision },
      relationshipRevision: await store.network.relationshipRevision(a.account.id, b.account.id),
    };
    await store.network.db.prepare("INSERT INTO meetings (id, initiator_id, first_user_id, second_user_id, request_id, payload_hash, revision, state_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(input.id, a.account.id, a.account.id, b.account.id, randomUUID(), "test", 1, JSON.stringify(state));
    await attach();
  });
  afterEach(() => store.close());
  it("blocks publishing until both people approve the same slot, including after preflight", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const prepared = await prepareMeetingCalendar(store, a.account.id, input);
    state.approvals = { [a.account.id]: "chosen" }; await writeState();
    await expect(prepareMeetingCalendar(store, a.account.id, input)).rejects.toThrow("approval_required");
    await expect(publishApprovedMeeting(store, a.account.id, input, prepared)).rejects.toThrow("approval_required");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps read-only grants usable and requests incremental write access only for confirmed meetings", async () => {
    await attach(false);
    await expect(prepareMeetingCalendar(store, a.account.id, input)).rejects.toThrow("needs_upgrade");
    const url = new URL(await beginCalendarConnection(store, a.token, { purpose: "meeting", meetingId: input.id }));
    expect(url.searchParams.get("scope")).toContain(CALENDAR_WRITE_SCOPE);
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect((await calendarStatus(store, a.token)).meetingPublishingReady).toBe(false);
    state.approvals = {}; await writeState();
    await expect(beginCalendarConnection(store, a.token, { purpose: "meeting", meetingId: input.id })).rejects.toThrow("approval_required");
  });
  it("preserves the original connection when write authorization is denied", async () => {
    await attach(false);
    const original = await store.readCalendar(a.token);
    const stateId = new URL(await beginCalendarConnection(store, a.token, { purpose: "meeting", meetingId: input.id })).searchParams.get("state")!;
    await expect(finishCalendarConnection(store, a.token, stateId, null, true)).rejects.toThrow("denied");
    expect(await store.readCalendar(a.token)).toEqual(original);
  });
  it("preserves selected calendars on upgrade and rejects switching Google identity", async () => {
    await attach(false);
    let subject = "other-google-owner";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/token")) return reply({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: [...CALENDAR_SCOPES, CALENDAR_WRITE_SCOPE].join(" "), token_type: "Bearer" });
      if (url.includes("userinfo")) return reply({ sub: subject, email: "owner@example.test", email_verified: true });
      return reply({ items: [{ id: "owner@example.test", primary: true }, { id: "work@example.test" }] });
    }));
    let stateId = new URL(await beginCalendarConnection(store, a.token, { purpose: "meeting", meetingId: input.id })).searchParams.get("state")!;
    const original = await store.readCalendar(a.token);
    await expect(finishCalendarConnection(store, a.token, stateId, "code", false)).rejects.toThrow("account_changed");
    expect(await store.readCalendar(a.token)).toEqual(original);
    subject = "google-owner";
    stateId = new URL(await beginCalendarConnection(store, a.token, { purpose: "meeting", meetingId: input.id })).searchParams.get("state")!;
    const returnTo = vi.fn();
    const token = await finishCalendarConnection(store, a.token, stateId, "code", false, returnTo);
    expect((await store.readCalendar(token)).connection?.selectedIds).toEqual(["work@example.test"]);
    expect((await calendarStatus(store, token)).meetingPublishingReady).toBe(true);
    expect(returnTo).toHaveBeenCalledWith(`/onboarding?agents=1&person=${b.account.id}`);
  });
  it("resolves attendee emails from accounts and reuses one organizer and event ID", async () => {
    const prepared = await prepareMeetingCalendar(store, a.account.id, input);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST") return reply({}, 404);
      const body = JSON.parse(init.body as string);
      return reply({ ...event({ ...providerInput, meetingId: input.id, eventId: prepared.eventId }), ...body, htmlLink: "https://calendar.google.com/calendar/event?eid=test", conferenceData: event().conferenceData });
    });
    vi.stubGlobal("fetch", fetch);
    const result = await publishApprovedMeeting(store, a.account.id, input, prepared);
    expect(result.status).toBe("scheduled");
    expect(JSON.parse(fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as string).attendees).toEqual([{ email: "friend@example.test" }]);
    expect((await prepareMeetingCalendar(store, a.account.id, input, result)).eventId).toBe(prepared.eventId);
    await expect(prepareMeetingCalendar(store, b.account.id, input, result)).rejects.toThrow("account_changed");
  });
  it("refuses calendar writes after the connection is revoked", async () => {
    const prepared = await prepareMeetingCalendar(store, a.account.id, input);
    await store.network.connectionAction(a.account.id, b.account.id, "remove");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(publishApprovedMeeting(store, a.account.id, input, prepared)).rejects.toThrow("approval_required");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses old approvals after the profile changes", async () => {
    const prepared = await prepareMeetingCalendar(store, a.account.id, input);
    const profile = await store.network.profile(a.account.id);
    const context = profile.context!;
    context.goal.text = "Explore a different objective for this visit.";
    await store.save(a.token, { context, baseRevision: profile.revision, requestId: randomUUID() });
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(publishApprovedMeeting(store, a.account.id, input, prepared)).rejects.toThrow("approval_required");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not restore old meeting authority by removing and reconnecting a friend", async () => {
    const prepared = await prepareMeetingCalendar(store, a.account.id, input);
    await store.network.connectionAction(a.account.id, b.account.id, "remove");
    await store.network.requestConnection(a.account.id, b.account.id, { source: "qr", token: (await store.network.settings(b.account.id)).qrToken, context: "A new connection" });
    await store.network.connectionAction(b.account.id, a.account.id, "accept");
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(publishApprovedMeeting(store, a.account.id, input, prepared)).rejects.toThrow("approval_required");
    expect(fetch).not.toHaveBeenCalled();
  });
});
