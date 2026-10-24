import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALENDAR_SCOPES,
  calendarWindow,
  snapshotIsFresh,
  type CalendarConnection,
} from "../src/lib/domain/calendar";
import { draftFromContext } from "../src/lib/domain/onboarding-chat";
import {
  openCalendarData,
  sealCalendarData,
} from "../src/lib/server/calendar-crypto";
import {
  beginCalendarConnection,
  calendarStatus,
  disconnectCalendar,
  finishCalendarConnection,
  selectCalendars,
  syncCalendar,
} from "../src/lib/server/calendar-service";
import {
  googleBusy,
  googleCalendarConfig,
  googleCalendars,
  type GoogleTokens,
} from "../src/lib/server/google-calendar";
import { ContextStore } from "../src/lib/server/store";
import { validContext } from "./fixtures";

let store: ContextStore, token: string;
const tokens: GoogleTokens = {
  accessToken: "test-access",
  refreshToken: "test-refresh",
  expiresAt: Date.now() + 3600000,
  scopes: [...CALENDAR_SCOPES],
};
const window = calendarWindow("2026-10-24", "2026-11-05")!;
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function connection(owner?: string): Promise<CalendarConnection> {
  owner ??= await store.calendarOwner(token);
  return {
    subject: "test-google-subject",
    email: "alex@example.test",
    encryptedTokens: sealCalendarData(tokens, owner),
    calendars: [
      {
        id: "primary@example.test",
        name: "Personal",
        primary: true,
        timezone: "America/Los_Angeles",
      },
      {
        id: "work@example.test",
        name: "Work",
        primary: false,
        timezone: "America/Los_Angeles",
      },
    ],
    selectedIds: ["primary@example.test"],
    snapshot: null,
    issue: null,
  };
}
async function draft() {
  return await store.commitChat(
    token,
    {
      action: "message",
      revision: 0,
      requestId: randomUUID(),
      message: "My profile",
    },
    { reply: "Ready to review.", draft: draftFromContext(validContext()) },
  );
}
async function attached() {
  await draft();
  await store.writeCalendar(token, 0, await connection());
}
function freeBusyBody(ids = ["primary@example.test"]) {
  return {
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    calendars: Object.fromEntries(ids.map((id) => [id, { busy: [] }])),
  };
}

beforeEach(async () => {
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
  vi.stubEnv(
    "GOOGLE_REDIRECT_URI",
    "http://127.0.0.1:3000/api/calendar/callback",
  );
  store = new ContextStore(":memory:");
  token = (await store.ensureSession()).token;
});
afterEach(() => {
  store.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("calendar credentials and OAuth", () => {
  it.each([
    { errors: [{ reason: "accessNotConfigured" }] },
    {
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
        },
      ],
    },
  ])(
    "distinguishes a disabled Calendar API from missing user permissions: %j",
    async (error) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => reply({ error }, 403)),
      );
      await expect(
        googleCalendars("test-access", AbortSignal.timeout(1000)),
      ).rejects.toThrow("api_disabled");
    },
  );

  it("still requires reconnection when Google denies calendar permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply(
          { error: { errors: [{ reason: "insufficientPermissions" }] } },
          403,
        ),
      ),
    );
    await expect(
      googleCalendars("test-access", AbortSignal.timeout(1000)),
    ).rejects.toThrow("missing_permissions");
  });

  it("encrypts tokens for one owner and rejects tampering", async () => {
    const encrypted = sealCalendarData(tokens, "owner");
    expect(encrypted).not.toContain(tokens.refreshToken);
    expect(openCalendarData(encrypted, "owner")).toEqual(tokens);
    expect(() => openCalendarData(encrypted, "other-owner")).toThrow();
    const pieces = encrypted.split(".");
    pieces[3] = (pieces[3][0] === "A" ? "B" : "A") + pieces[3].slice(1);
    expect(() => openCalendarData(pieces.join("."), "owner")).toThrow();
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
    expect(googleCalendarConfig()).toBeNull();
  });

  it("uses least-privilege scopes and a PKCE challenge without exposing secrets", async () => {
    const url = new URL(await beginCalendarConnection(store, token));
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      ...CALENDAR_SCOPES,
    ]);
    expect(url.search).not.toContain("test-secret");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("binds state to the session, expires it, and consumes it only once", async () => {
    const other = (await store.ensureSession()).token;
    await store.startCalendarOAuth(token, "state", "encrypted", 100);
    await expect(
      store.consumeCalendarOAuth(other, "state", 101),
    ).rejects.toThrow("invalid_state");
    await expect(
      store.consumeCalendarOAuth(token, "wrong", 101),
    ).rejects.toThrow("invalid_state");
    expect(
      (await store.consumeCalendarOAuth(token, "state", 101))
        .encrypted_verifier,
    ).toBe("encrypted");
    await expect(
      store.consumeCalendarOAuth(token, "state", 101),
    ).rejects.toThrow("invalid_state");
    await store.startCalendarOAuth(token, "expired", "encrypted", 100);
    await expect(
      store.consumeCalendarOAuth(token, "expired", 600101),
    ).rejects.toThrow("invalid_state");
    await expect(
      store.consumeCalendarOAuth(token, "expired", 101),
    ).rejects.toThrow("invalid_state");
  });

  it("consumes denied attempts without contacting Google", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const state = new URL(
      await beginCalendarConnection(store, token),
    ).searchParams.get("state")!;
    await expect(
      finishCalendarConnection(store, token, state, null, true),
    ).rejects.toThrow("denied");
    await expect(
      finishCalendarConnection(store, token, state, "code", false),
    ).rejects.toThrow("invalid_state");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("verifies account and scopes, rotates the session, and preserves profile history", async () => {
    const chat = await draft();
    await store.commitChat(token, {
      action: "confirm",
      revision: chat.revision,
      requestId: randomUUID(),
    });
    const state = new URL(
      await beginCalendarConnection(store, token),
    ).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/token"))
          return reply({
            access_token: "test-access",
            refresh_token: "test-refresh",
            expires_in: 3600,
            scope: CALENDAR_SCOPES.join(" "),
            token_type: "Bearer",
          });
        if (url.includes("userinfo"))
          return reply({
            sub: "google-subject",
            email: "alex@example.test",
            email_verified: true,
          });
        return reply({
          items: [
            { id: "primary@example.test", summary: "Personal", primary: true },
          ],
        });
      }),
    );
    const next = await finishCalendarConnection(
      store,
      token,
      state,
      "test-code",
      false,
    );
    expect(next).not.toBe(token);
    expect(await store.read(token)).toBeNull();
    expect((await store.readChat(next)).confirmed).toBe(true);
    expect((await store.readChat(next)).messages).toHaveLength(3);
    const saved = (await store.readCalendar(next)).connection!;
    expect(saved.subject).toBe("google-subject");
    expect(saved.selectedIds).toEqual(["primary@example.test"]);
    expect(
      openCalendarData<GoogleTokens>(
        saved.encryptedTokens,
        await store.calendarOwner(next),
      ).refreshToken,
    ).toBe("test-refresh");
    expect(JSON.stringify(await calendarStatus(store, next))).not.toMatch(
      /test-access|test-refresh|encryptedTokens|subject/,
    );
    expect((await calendarStatus(store, next)).onboardingComplete).toBe(false);
  });

  it("does not let an older OAuth attempt replace a later disconnect", async () => {
    const connected = await connection();
    await store.writeCalendar(token, 0, await connection());
    await store.writeCalendar(token, 1, null);
    await expect(
      store.connectCalendar(token, 1, () => connected),
    ).rejects.toThrow("calendar_changed");
    expect((await store.readCalendar(token)).connection).toBeNull();
  });
});

describe("availability and completion", () => {
  it("uses inclusive SF dates across the daylight-saving transition", async () => {
    const day = calendarWindow("2026-11-01", "2026-11-01")!;
    expect(Date.parse(day.timeMax) - Date.parse(day.timeMin)).toBe(
      25 * 3600000,
    );
    expect(calendarWindow("2026-11-02", "2026-11-01")).toBeNull();
    expect(calendarWindow("2026-02-30", "2026-03-01")).toBeNull();
  });

  it("requires both confirmation and current successful calendar coverage", async () => {
    await attached();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(freeBusyBody())),
    );
    expect((await calendarStatus(store, token)).onboardingComplete).toBe(false);
    expect((await syncCalendar(store, token)).availabilityReady).toBe(true);
    expect((await calendarStatus(store, token)).onboardingComplete).toBe(false);
    await store.commitChat(token, {
      action: "confirm",
      revision: 1,
      requestId: randomUUID(),
    });
    expect((await calendarStatus(store, token)).onboardingComplete).toBe(true);
    expect(
      (await calendarStatus(store, token, Date.now() + 300001))
        .onboardingComplete,
    ).toBe(false);
    expect(
      (await calendarStatus(store, (await store.ensureSession()).token))
        .onboardingComplete,
    ).toBe(false);
    const status = JSON.stringify(await calendarStatus(store, token));
    expect(status).not.toContain('"busy"');
    const next = draftFromContext(validContext());
    next.departure = "2026-11-06";
    await store.commitChat(
      token,
      {
        action: "message",
        revision: 2,
        requestId: randomUUID(),
        message: "Stay one more day",
      },
      { reply: "Updated your draft.", draft: next },
    );
    expect((await calendarStatus(store, token)).availabilityReady).toBe(false);
  });

  it("invalidates coverage when selected calendars change and rejects foreign IDs", async () => {
    await attached();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply(freeBusyBody())),
    );
    await syncCalendar(store, token);
    await expect(
      selectCalendars(store, token, 2, ["unowned-id"]),
    ).rejects.toThrow("invalid_selection");
    expect(
      (
        await selectCalendars(store, token, 2, [
          "primary@example.test",
          "work@example.test",
        ])
      ).availabilityReady,
    ).toBe(false);
    await expect(
      selectCalendars(store, token, 2, ["primary@example.test"]),
    ).rejects.toThrow("calendar_changed");
    const c = (await store.readCalendar(token)).connection!;
    expect(
      snapshotIsFresh(
        {
          ...c,
          snapshot: {
            window,
            calendarIds: ["primary@example.test"],
            checkedAt: new Date().toISOString(),
            busy: [],
          },
        },
        window,
      ),
    ).toBe(false);
  });

  it.each([
    { calendars: {} },
    {
      calendars: {
        "primary@example.test": { errors: [{ reason: "notFound" }] },
      },
    },
    { calendars: { "primary@example.test": {} } },
  ])(
    "never treats missing or failed calendars as free: %j",
    async (partial) => {
      await attached();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => reply({ ...freeBusyBody(), ...partial })),
      );
      await expect(syncCalendar(store, token)).rejects.toThrow(
        "calendar_unavailable",
      );
      expect((await calendarStatus(store, token)).availabilityReady).toBe(
        false,
      );
      expect((await store.readCalendar(token)).connection!.snapshot).toBeNull();
    },
  );

  it("merges busy intervals without retaining event details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        reply({
          ...freeBusyBody(),
          calendars: {
            "primary@example.test": {
              busy: [
                {
                  start: "2026-10-25T09:00:00-07:00",
                  end: "2026-10-25T10:00:00-07:00",
                },
                { start: "2026-10-25T16:30:00Z", end: "2026-10-25T18:00:00Z" },
              ],
            },
          },
        }),
      ),
    );
    expect(
      await googleBusy(
        "test-access",
        ["primary@example.test"],
        window,
        AbortSignal.timeout(1000),
      ),
    ).toEqual([
      { start: "2026-10-25T16:00:00.000Z", end: "2026-10-25T18:00:00.000Z" },
    ]);
  });

  it("refreshes expired access, saves the new token, and rejects revoked grants", async () => {
    await attached();
    let record = await store.readCalendar(token);
    await store.writeCalendar(token, record.revision, {
      ...record.connection!,
      encryptedTokens: sealCalendarData(
        { ...tokens, expiresAt: 0 },
        await store.calendarOwner(token),
      ),
    });
    const fetch = vi.fn(async (url: string) =>
      url.includes("/token")
        ? reply({
            access_token: "refreshed-access",
            expires_in: 3600,
            token_type: "Bearer",
          })
        : reply(freeBusyBody()),
    );
    vi.stubGlobal("fetch", fetch);
    expect((await syncCalendar(store, token)).availabilityReady).toBe(true);
    record = await store.readCalendar(token);
    expect(
      openCalendarData<GoogleTokens>(
        record.connection!.encryptedTokens,
        await store.calendarOwner(token),
      ).accessToken,
    ).toBe("refreshed-access");
    await store.writeCalendar(token, record.revision, {
      ...record.connection!,
      encryptedTokens: sealCalendarData(
        { ...tokens, expiresAt: 0 },
        await store.calendarOwner(token),
      ),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => reply({ error: "invalid_grant" }, 400)),
    );
    await expect(syncCalendar(store, token)).rejects.toThrow("needs_reconnect");
    expect((await calendarStatus(store, token)).status).toBe("needs_reconnect");
    expect((await calendarStatus(store, token)).availabilityReady).toBe(false);
  });

  it("prevents an in-flight sync from resurrecting a disconnected calendar", async () => {
    await attached();
    let release!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.includes("revoke")
          ? Promise.resolve(reply({}))
          : new Promise<Response>((resolve) => {
              release = resolve;
            }),
      ),
    );
    const sync = syncCalendar(store, token);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(syncCalendar(store, token)).rejects.toThrow("busy");
    const disconnected = await disconnectCalendar(store, token, 1);
    expect(disconnected.status).toBe("not_connected");
    release(reply(freeBusyBody()));
    await expect(sync).rejects.toThrow("calendar_changed");
    expect((await store.readCalendar(token)).connection).toBeNull();
  });

  it("shares the calendar sync lease across independent database clients and releases it after completion", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sidekick-calendar-lease-"));
    const path = join(directory, "test.sqlite");
    store.close();
    store = new ContextStore(path);
    token = (await store.ensureSession()).token;
    await attached();
    const other = new ContextStore(path);
    let release!: (value: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const pending = syncCalendar(store, token);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      await expect(syncCalendar(other, token)).rejects.toThrow("busy");
      expect(fetch).toHaveBeenCalledTimes(1);
      release(reply(freeBusyBody()));
      expect((await pending).availabilityReady).toBe(true);
      fetch.mockImplementation(async () => reply(freeBusyBody()));
      expect((await syncCalendar(other, token)).availabilityReady).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      other.close();
      store.close();
      store = new ContextStore(":memory:");
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes local access even when remote revocation cannot be verified", async () => {
    await attached();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    expect(await disconnectCalendar(store, token, 1)).toMatchObject({
      revoked: false,
      status: "not_connected",
      onboardingComplete: false,
    });
    expect((await store.readCalendar(token)).connection).toBeNull();
  });
});
