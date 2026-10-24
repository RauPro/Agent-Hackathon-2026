import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALENDAR_SCOPES,
  type CalendarConnection,
} from "../src/lib/domain/calendar";
import {
  manualMeetingSlot,
  type MeetingView,
} from "../src/lib/domain/meetings";
import { sealCalendarData } from "../src/lib/server/calendar-crypto";
import { MeetingService } from "../src/lib/server/meeting-service";
import { ContextStore } from "../src/lib/server/store";
import { validContext } from "./fixtures";

let store: ContextStore, service: MeetingService;
let a: Awaited<ReturnType<ContextStore["registerAccount"]>>,
  b: typeof a,
  outsider: typeof a;
let folder: string, dbPath: string;
const manual = [manualMeetingSlot("2026-10-26", "09:00", "12:00")];
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function user(email: string, name: string) {
  const value = await store.registerAccount(email, "unused-test-hash");
  const context = validContext();
  context.profile.name = name;
  await store.save(value.token, {
    context,
    baseRevision: 0,
    requestId: randomUUID(),
  });
  return value;
}
async function propose(purpose = "Discuss a founding engineer opportunity") {
  return await service.propose(a.account.id, {
    toUserId: b.account.id,
    requestId: randomUUID(),
    purpose,
    location: "Ferry Building, main entrance",
  });
}
async function options() {
  let value = await propose();
  value = await service.optIn(a.account.id, {
    meetingId: value.id,
    revision: value.revision,
    manualSlots: manual,
  });
  return service.optIn(b.account.id, {
    meetingId: value.id,
    revision: value.revision,
    manualSlots: manual,
  });
}
async function connectCalendar(account: typeof a, expired = false) {
  const owner = await store.calendarOwner(account.token);
  const connection: CalendarConnection = {
    subject: `google-${account.account.id}`,
    email: `private-${account.account.id}@example.test`,
    encryptedTokens: sealCalendarData(
      {
        accessToken: `access-${account.account.id}`,
        refreshToken: `refresh-${account.account.id}`,
        expiresAt: expired ? 0 : Date.now() + 3600000,
        scopes: [...CALENDAR_SCOPES],
      },
      owner,
    ),
    calendars: [
      {
        id: `private-${account.account.id}`,
        name: "Private appointments",
        primary: true,
        timezone: "America/Los_Angeles",
      },
    ],
    selectedIds: [`private-${account.account.id}`],
    snapshot: null,
    issue: null,
  };
  await store.writeCalendar(account.token, 0, connection);
}
function calendarReply(
  init: RequestInit,
  busy: { start: string; end: string }[] = [],
) {
  const body = JSON.parse(init.body as string) as {
    timeMin: string;
    timeMax: string;
    items: { id: string }[];
  };
  return response({
    timeMin: body.timeMin,
    timeMax: body.timeMax,
    calendars: Object.fromEntries(body.items.map(({ id }) => [id, { busy }])),
  });
}
async function calendarOptions() {
  let value = await propose();
  value = await service.optIn(a.account.id, {
    meetingId: value.id,
    revision: value.revision,
  });
  return service.optIn(b.account.id, {
    meetingId: value.id,
    revision: value.revision,
  });
}
async function approveBoth(value: MeetingView, optionId = value.options[0].id) {
  value = await service.approve(a.account.id, {
    meetingId: value.id,
    revision: value.revision,
    optionId,
  });
  return service.approve(b.account.id, {
    meetingId: value.id,
    revision: value.revision,
    optionId,
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-24T17:00:00Z"));
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
  vi.stubEnv(
    "GOOGLE_REDIRECT_URI",
    "http://127.0.0.1:3000/api/calendar/callback",
  );
  folder = mkdtempSync(join(tmpdir(), "sidekick-meetings-"));
  dbPath = join(folder, "test.sqlite");
  store = new ContextStore(dbPath);
  service = new MeetingService(store);
  a = await user("alex@example.test", "Alex Rivera");
  b = await user("blair@example.test", "Blair Morgan");
  outsider = await user("casey@example.test", "Casey Hill");
  const token = (await store.network.settings(b.account.id)).qrToken;
  await store.network.requestConnection(a.account.id, b.account.id, {
    source: "qr",
    token,
    context: "Met at a test event",
  });
  await store.network.connectionAction(b.account.id, a.account.id, "accept");
});
afterEach(() => {
  store.close();
  rmSync(folder, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("bilateral meeting agreements", () => {
  it("persists an ordered factual history and makes consent and approval retries idempotent", async () => {
    const input = {
      toUserId: b.account.id,
      requestId: randomUUID(),
      purpose: "Discuss technical opportunities",
      location: "Ferry Building, main entrance",
    };
    let value = await service.propose(a.account.id, input);
    const createdAt = value.createdAt;
    const initial = value.activity;
    vi.setSystemTime(Date.now() + 1000);
    expect((await service.propose(a.account.id, input)).activity).toEqual(
      initial,
    );
    const consent = {
      meetingId: value.id,
      revision: value.revision,
      manualSlots: manual,
    };
    value = await service.optIn(a.account.id, consent);
    const firstConsent = value;
    vi.setSystemTime(Date.now() + 1000);
    expect(await service.optIn(a.account.id, consent)).toEqual(firstConsent);
    value = await service.optIn(b.account.id, {
      ...consent,
      revision: value.revision,
    });
    const ready = value;
    expect(await service.optIn(a.account.id, consent)).toEqual(ready);
    vi.setSystemTime(Date.now() + 1000);
    const approval = {
      meetingId: value.id,
      revision: value.revision,
      optionId: value.options[0].id,
    };
    value = await service.approve(a.account.id, approval);
    expect(await service.approve(a.account.id, approval)).toEqual(value);
    vi.setSystemTime(Date.now() + 1000);
    value = await service.approve(b.account.id, {
      ...approval,
      revision: value.revision,
      optionId: value.options[1].id,
    });
    vi.setSystemTime(Date.now() + 1000);
    const finalApproval = {
      ...approval,
      revision: value.revision,
      optionId: value.options[1].id,
    };
    value = await service.approve(a.account.id, finalApproval);
    expect(value.activity.map((entry) => entry.kind)).toEqual([
      "proposed",
      "availability_consented",
      "availability_consented",
      "options_ready",
      "option_approved",
      "option_counterproposed",
      "option_approved",
      "confirmed",
    ]);
    expect(value.activity.map((entry) => entry.actorUserId)).toEqual([
      a.account.id,
      a.account.id,
      b.account.id,
      undefined,
      a.account.id,
      b.account.id,
      a.account.id,
      undefined,
    ]);
    expect(value.activity[0].at).toBe(createdAt);
    const times = value.activity.map((entry) => entry.at);
    expect(times).toEqual([...times].sort());
    expect(new Set(value.activity.map((entry) => entry.id)).size).toBe(8);
    expect(JSON.stringify(value.activity)).not.toMatch(
      /manualSlots|calendar|T16:00/,
    );
    vi.setSystemTime(Date.now() + 1000);
    expect(await service.approve(a.account.id, finalApproval)).toEqual(value);
    store.close();
    store = new ContextStore(dbPath);
    service = new MeetingService(store);
    expect((await service.list(b.account.id))[0].activity).toEqual(
      value.activity,
    );
  });

  it("keeps revoked history as action metadata without exposing the old meeting options", async () => {
    let value = await options();
    const optionId = value.options[0].id;
    value = await service.approve(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
      optionId,
    });
    await store.network.connectionAction(b.account.id, a.account.id, "block");
    vi.setSystemTime(Date.now() + 1000);
    value = (await service.list(a.account.id))[0];
    expect(value.activity.at(-1)).toMatchObject({ kind: "stale" });
    expect(
      value.activity.some((entry) => entry.kind === "option_approved"),
    ).toBe(true);
    expect(value.options).toEqual([]);
    expect(JSON.stringify(value.activity)).not.toContain(optionId);
    expect(value.activity.every((entry) => !entry.optionId)).toBe(true);
    vi.setSystemTime(Date.now() + 1000);
    expect((await service.list(a.account.id))[0].activity).toEqual(
      value.activity,
    );
    expect(await service.list(outsider.account.id)).toEqual([]);
  });

  it("normalizes revoked meeting history once when independent clients read it concurrently", async () => {
    const value = await options();
    await store.network.connectionAction(a.account.id, b.account.id, "block");
    const other = new ContextStore(dbPath);
    try {
      const secondService = new MeetingService(other);
      const [first, second] = await Promise.all([
        service.list(a.account.id),
        secondService.list(b.account.id),
      ]);
      expect(first[0].status).toBe("stale");
      expect(second[0].status).toBe("stale");
      expect(first[0].revision).toBe(value.revision + 1);
      expect(second[0].revision).toBe(first[0].revision);
      expect(
        first[0].activity.filter((entry) => entry.kind === "stale"),
      ).toHaveLength(1);
      expect(second[0].activity).toEqual(first[0].activity);
      expect(first[0].options).toEqual([]);
    } finally {
      other.close();
    }
  });

  it("does not invent response times for older records without activity", async () => {
    let value = await options();
    const row = (await store.network.db
      .prepare("SELECT state_json FROM meetings WHERE id = ?")
      .get(value.id)) as { state_json: string };
    const record = JSON.parse(row.state_json);
    delete record.activity;
    await store.network.db
      .prepare("UPDATE meetings SET state_json = ? WHERE id = ?")
      .run(JSON.stringify(record), value.id);
    vi.setSystemTime(Date.now() + 1000);
    value = (await service.list(a.account.id))[0];
    expect(value.activity).toEqual([
      {
        id: `${value.id}:proposed`,
        at: value.createdAt,
        kind: "proposed",
        actorUserId: a.account.id,
      },
    ]);
    const withdrawal = { meetingId: value.id, revision: value.revision };
    value = await service.withdraw(b.account.id, withdrawal);
    expect(value.activity.map((entry) => entry.kind)).toEqual([
      "proposed",
      "withdrawn",
    ]);
    expect(value.activity[1].at).toBe(new Date().toISOString());
    vi.setSystemTime(Date.now() + 1000);
    expect((await service.withdraw(b.account.id, withdrawal)).activity).toEqual(
      value.activity,
    );
  });

  it("requires both availability consents and both approvals; exports without sending an invitation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let value = await propose();
    expect(value.manualAvailabilityNeeded).toBe(true);
    value = await service.optIn(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
      manualSlots: manual,
    });
    expect(value.status).toBe("awaiting_permission");
    expect(value.options).toEqual([]);
    await expect(
      service.exportICS(a.account.id, value.id),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "approval_required" }),
    );
    value = await service.optIn(b.account.id, {
      meetingId: value.id,
      revision: value.revision,
      manualSlots: manual,
    });
    expect(value.status).toBe("options_ready");
    expect(value.options).toHaveLength(3);
    expect(value.options[0].start).toBe("2026-10-26T16:00:00.000Z");
    expect(value.availabilitySource).toBe("manual");
    value = await service.approve(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
      optionId: value.options[0].id,
    });
    expect(value.status).toBe("options_ready");
    expect(value.calendarStatus).toBe("not_ready");
    value = await service.approve(b.account.id, {
      meetingId: value.id,
      revision: value.revision,
      optionId: value.options[0].id,
    });
    expect(value.status).toBe("confirmed");
    expect(value.calendarStatus).toBe("export_available");
    const ics = await service.exportICS(a.account.id, value.id);
    expect(ics).toContain(`UID:${value.id}@sidekick.local`);
    expect(ics).toContain("DTSTART:20261026T160000Z");
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).not.toMatch(/ATTENDEE|ORGANIZER|mailto:/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is idempotent across request and approval retries and survives reopening", async () => {
    const input = {
      toUserId: b.account.id,
      requestId: randomUUID(),
      purpose: "Review a technical leadership role",
      location: "Public library entrance",
    };
    const first = await service.propose(a.account.id, input);
    expect((await service.propose(a.account.id, input)).id).toBe(first.id);
    await expect(
      service.propose(a.account.id, { ...input, location: "Changed place" }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "request_conflict" }),
    );
    let value = await options();
    const optionId = value.options[0].id;
    const revision = value.revision;
    value = await service.approve(a.account.id, {
      meetingId: value.id,
      revision,
      optionId,
    });
    expect(
      (
        await service.approve(a.account.id, {
          meetingId: value.id,
          revision,
          optionId,
        })
      ).revision,
    ).toBe(value.revision);
    value = await service.approve(b.account.id, {
      meetingId: value.id,
      revision: value.revision,
      optionId,
    });
    expect(
      (
        await service.approve(b.account.id, {
          meetingId: value.id,
          revision: revision - 1,
          optionId,
        })
      ).revision,
    ).toBe(value.revision);
    const ics = await service.exportICS(b.account.id, value.id);
    store.close();
    store = new ContextStore(dbPath);
    service = new MeetingService(store);
    expect(
      (await service.list(a.account.id)).find(
        (meeting) => meeting.id === value.id,
      )?.status,
    ).toBe("confirmed");
    expect(await service.exportICS(b.account.id, value.id)).toBe(ics);
  });

  it("rejects outsiders and stops communication after removal or blocking", async () => {
    let value = await options();
    await expect(
      service.approve(outsider.account.id, {
        meetingId: value.id,
        revision: value.revision,
        optionId: value.options[0].id,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "not_found" }));
    await expect(
      service.exportICS(outsider.account.id, value.id),
    ).rejects.toThrowError(expect.objectContaining({ code: "not_found" }));
    await expect(
      service.propose(a.account.id, {
        toUserId: outsider.account.id,
        requestId: randomUUID(),
        purpose: "Try an unauthorized meeting",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "not_connected" }));
    await store.network.connectionAction(b.account.id, a.account.id, "block");
    await expect(
      service.approve(a.account.id, {
        meetingId: value.id,
        revision: value.revision,
        optionId: value.options[0].id,
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "not_connected" }));
    value = (await service.list(a.account.id))[0];
    expect(value.status).toBe("stale");
    expect(value.options).toEqual([]);
  });

  it("keeps prior meeting consent revoked after removing and reconnecting before any meeting read", async () => {
    const value = await options();
    await store.network.connectionAction(a.account.id, b.account.id, "remove");
    const token = (await store.network.settings(b.account.id)).qrToken;
    await store.network.requestConnection(a.account.id, b.account.id, {
      source: "qr",
      token,
      context: "Met again at a test event",
    });
    await store.network.connectionAction(b.account.id, a.account.id, "accept");
    await expect(
      service.approve(a.account.id, {
        meetingId: value.id,
        revision: value.revision,
        optionId: value.options[0].id,
      }),
    ).rejects.toMatchObject({ code: "meeting_changed" });
    expect((await service.list(a.account.id))[0].status).toBe("stale");
    expect((await propose()).status).toBe("awaiting_permission");
  });

  it("bounds proposal spam and provides useful English error messages", async () => {
    for (let index = 0; index < 10; index++)
      await propose(`Discuss technical project number ${index}`);
    try {
      await propose();
      throw new Error("Expected the daily proposal limit");
    } catch (error) {
      expect(error).toMatchObject({
        code: "rate_limit",
        status: 429,
        message: "You have proposed ten meetings today. Try again tomorrow.",
      });
    }
  });

  it("refuses a new export after a profile changes, even if both users already confirmed", async () => {
    const value = await approveBoth(await options());
    const context = validContext();
    context.profile.name = "Alex Rivera";
    context.trip.end = "2026-10-25";
    await store.save(a.token, {
      context,
      baseRevision: 1,
      requestId: randomUUID(),
    });
    await expect(
      service.exportICS(a.account.id, value.id),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "meeting_changed" }),
    );
    expect((await service.list(a.account.id))[0].calendarStatus).toBe(
      "not_ready",
    );
  });

  it("invalidates stale profile revisions and expires proposals", async () => {
    const value = await options();
    const context = validContext();
    context.profile.name = "Alex Rivera";
    context.goal.text = "Explore a different confirmed opportunity";
    await store.save(a.token, {
      context,
      baseRevision: 1,
      requestId: randomUUID(),
    });
    await expect(
      service.approve(a.account.id, {
        meetingId: value.id,
        revision: value.revision,
        optionId: value.options[0].id,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "meeting_changed" }),
    );
    expect((await service.list(a.account.id))[0].status).toBe("stale");
    const fresh = await propose();
    vi.setSystemTime(Date.now() + 48 * 3600000 + 1);
    const expired = (await service.list(a.account.id)).find(
      (meeting) => meeting.id === fresh.id,
    )!;
    expect(expired.status).toBe("expired");
    expect(expired.activity.map((entry) => entry.kind)).toEqual([
      "proposed",
      "expired",
    ]);
    expect(expired.activity.at(-1)?.at).toBe(new Date().toISOString());
    expect(
      (await service.list(a.account.id)).find(
        (meeting) => meeting.id === fresh.id,
      )?.activity,
    ).toEqual(expired.activity);
  });

  it("uses preferences and additional commitments, and never treats missing manual times as free", async () => {
    const context = validContext();
    context.profile.name = "Alex Rivera";
    context.availability = {
      status: "provided",
      windows: [{ date: "2026-10-26", start: "10:00", end: "12:00" }],
    };
    context.commitments = {
      status: "provided",
      items: [
        {
          date: "2026-10-26",
          start: "10:00",
          end: "10:30",
          title: "Private appointment",
        },
      ],
    };
    await store.save(a.token, {
      context,
      baseRevision: 1,
      requestId: randomUUID(),
    });
    const pending = await propose();
    await expect(
      service.optIn(a.account.id, {
        meetingId: pending.id,
        revision: pending.revision,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "manual_required" }),
    );
    const value = await options();
    expect(value.options[0].start).toBe("2026-10-26T17:30:00.000Z");
    expect(JSON.stringify(value)).not.toContain("Private appointment");
  });

  it("resets previous approvals when a different option is selected and supports withdrawal", async () => {
    let value = await options();
    value = await service.approve(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
      optionId: value.options[0].id,
    });
    value = await service.approve(b.account.id, {
      meetingId: value.id,
      revision: value.revision,
      optionId: value.options[1].id,
    });
    expect(value.approvedUserIds).toEqual([b.account.id]);
    expect(value.status).toBe("options_ready");
    value = await service.withdraw(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
    });
    expect(value.status).toBe("withdrawn");
    expect(value.approvedUserIds).toEqual([]);
    await expect(
      service.exportICS(b.account.id, value.id),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "approval_required" }),
    );
  });

  it("escapes ICS content so user text cannot inject properties", async () => {
    let value = await propose(
      "Discuss engineering\nATTENDEE:mailto:outsider@example.test",
    );
    value = await service.optIn(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
      manualSlots: manual,
    });
    value = await service.optIn(b.account.id, {
      meetingId: value.id,
      revision: value.revision,
      manualSlots: manual,
    });
    value = await approveBoth(value);
    const ics = await service.exportICS(a.account.id, value.id);
    expect(ics.split("\r\n").some((line) => line.startsWith("ATTENDEE:"))).toBe(
      false,
    );
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(
      ics.split("\r\n").every((line) => Buffer.byteLength(line) <= 75),
    ).toBe(true);
  });

  it("uses SF time after daylight saving and returns no options for incompatible manual availability", async () => {
    let value = await propose();
    const later = [manualMeetingSlot("2026-11-02", "09:00", "10:00")];
    value = await service.optIn(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
      manualSlots: later,
    });
    value = await service.optIn(b.account.id, {
      meetingId: value.id,
      revision: value.revision,
      manualSlots: later,
    });
    expect(value.options[0].start).toBe("2026-11-02T17:00:00.000Z");
    expect(() => manualMeetingSlot("2026-11-01", "01:00", "02:00")).toThrow();
    let other = await propose();
    other = await service.optIn(a.account.id, {
      meetingId: other.id,
      revision: other.revision,
      manualSlots: manual,
    });
    other = await service.optIn(b.account.id, {
      meetingId: other.id,
      revision: other.revision,
      manualSlots: later,
    });
    expect(other.options).toEqual([]);
    expect(other.status).toBe("awaiting_permission");
    expect(other.error).toContain("No common time");
    expect(other.activity.at(-1)?.kind).toBe("no_common_time");
    const history = other.activity;
    other = await service.optIn(b.account.id, {
      meetingId: other.id,
      revision: other.revision,
      manualSlots: later,
    });
    expect(other.activity).toEqual(history);
  });

  it("does not confirm overlapping meetings even when both proposals previously offered that time", async () => {
    const first = await options();
    let second = await options();
    expect(first.options[0].start).toBe(second.options[0].start);
    await approveBoth(first);
    const optionId = second.options[0].id;
    second = await service.approve(a.account.id, {
      meetingId: second.id,
      revision: second.revision,
      optionId,
    });
    await expect(
      service.approve(b.account.id, {
        meetingId: second.id,
        revision: second.revision,
        optionId,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "availability_changed" }),
    );
    expect(
      (await service.list(a.account.id)).find(
        (meeting) => meeting.id === second.id,
      )?.status,
    ).toBe("awaiting_permission");
  });
  it("serializes final approvals from independent clients so overlapping meetings cannot both confirm", async () => {
    let first = await options();
    let second = await options();
    first = await service.approve(a.account.id, {
      meetingId: first.id,
      revision: first.revision,
      optionId: first.options[0].id,
    });
    second = await service.approve(a.account.id, {
      meetingId: second.id,
      revision: second.revision,
      optionId: second.options[0].id,
    });
    const other = new ContextStore(dbPath);
    const otherService = new MeetingService(other);
    try {
      const outcomes = await Promise.allSettled([
        service.approve(b.account.id, {
          meetingId: first.id,
          revision: first.revision,
          optionId: first.options[0].id,
        }),
        otherService.approve(b.account.id, {
          meetingId: second.id,
          revision: second.revision,
          optionId: second.options[0].id,
        }),
      ]);
      expect(
        outcomes.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        outcomes.find((result) => result.status === "rejected"),
      ).toMatchObject({
        status: "rejected",
        reason: { code: "availability_changed" },
      });
      const meetings = await service.list(a.account.id);
      expect(
        meetings.filter((meeting) => meeting.status === "confirmed"),
      ).toHaveLength(1);
    } finally {
      other.close();
    }
  });
});

describe("fresh calendar coordination", () => {
  it("resumes the final fresh check after a restart between saving both approvals and confirmation", async () => {
    await connectCalendar(a);
    await connectCalendar(b);
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      calendarReply(init),
    );
    vi.stubGlobal("fetch", fetch);
    let value = await calendarOptions();
    const optionId = value.options[0].id;
    value = await service.approve(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
      optionId,
    });
    // Recreate the durable checkpoint immediately after the second approval was saved.
    const row = (await store.network.db
      .prepare("SELECT state_json FROM meetings WHERE id = ?")
      .get(value.id)) as { state_json: string };
    const saved = JSON.parse(row.state_json);
    saved.approvals[b.account.id] = optionId;
    saved.revision++;
    await store.network.db
      .prepare("UPDATE meetings SET revision = ?, state_json = ? WHERE id = ?")
      .run(saved.revision, JSON.stringify(saved), value.id);
    store.close();
    store = new ContextStore(dbPath);
    service = new MeetingService(store);
    value = await service.approve(b.account.id, {
      meetingId: value.id,
      revision: value.revision,
      optionId,
    });
    expect(value.status).toBe("confirmed");
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(await service.exportICS(a.account.id, value.id)).toContain(
      `UID:${value.id}@sidekick.local`,
    );
  });

  it("reads both connected calendars, hides busy intervals, and rechecks before confirmation", async () => {
    await connectCalendar(a, true);
    await connectCalendar(b);
    const busy = [manualMeetingSlot("2026-10-26", "09:00", "10:00")];
    const fetch = vi.fn(async (url: string, init: RequestInit) =>
      url.includes("/token")
        ? response({
            access_token: "refreshed",
            expires_in: 3600,
            token_type: "Bearer",
          })
        : calendarReply(init, busy),
    );
    vi.stubGlobal("fetch", fetch);
    let value = await calendarOptions();
    expect(value.options[0].start).toBe("2026-10-26T17:00:00.000Z");
    expect(value.availabilitySource).toBe("google");
    expect(JSON.stringify(value)).not.toMatch(
      /private-|access-|refresh-|selectedIds|encryptedTokens|busy/,
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    value = await approveBoth(value);
    expect(value.status).toBe("confirmed");
    expect(fetch).toHaveBeenCalledTimes(5);
    expect((await store.readCalendar(a.token)).revision).toBe(2);
  });

  it("fails closed on provider errors and prohibits silently replacing a connected calendar with manual times", async () => {
    await connectCalendar(a);
    await connectCalendar(b);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response({ error: "provider_failed" }, 503)),
    );
    let value = await propose();
    await expect(
      service.optIn(a.account.id, {
        meetingId: value.id,
        revision: value.revision,
        manualSlots: manual,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "manual_not_allowed" }),
    );
    value = await service.optIn(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
    });
    await expect(
      service.optIn(b.account.id, {
        meetingId: value.id,
        revision: value.revision,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "calendar_unavailable" }),
    );
    value = (await service.list(a.account.id))[0];
    expect(value.options).toEqual([]);
    expect(value.calendarStatus).toBe("not_ready");
    expect(value.error).toContain("could not be checked");
    expect(value.activity.map((entry) => entry.kind)).toEqual([
      "proposed",
      "availability_consented",
      "availability_consented",
      "availability_failed",
    ]);
    const history = value.activity;
    vi.setSystemTime(Date.now() + 1000);
    await expect(
      service.optIn(b.account.id, {
        meetingId: value.id,
        revision: value.revision,
      }),
    ).rejects.toMatchObject({ code: "calendar_unavailable" });
    expect((await service.list(a.account.id))[0].activity).toEqual(history);
  });

  it("rejects a calendar disconnected during an in-flight check", async () => {
    await connectCalendar(a);
    await connectCalendar(b);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      await gate;
      return calendarReply(init);
    });
    vi.stubGlobal("fetch", fetch);
    let value = await propose();
    value = await service.optIn(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
    });
    const pending = service.optIn(b.account.id, {
      meetingId: value.id,
      revision: value.revision,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await store.writeCalendar(a.token, 1, null);
    release();
    await expect(pending).rejects.toThrowError(
      expect.objectContaining({ code: "availability_changed" }),
    );
    expect((await service.list(a.account.id))[0].options).toEqual([]);
  });

  it("rejects a relationship revoked by another client while calendars are being checked", async () => {
    await connectCalendar(a);
    await connectCalendar(b);
    const other = new ContextStore(dbPath);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      await gate;
      return calendarReply(init);
    });
    vi.stubGlobal("fetch", fetch);
    try {
      let value = await propose();
      value = await service.optIn(a.account.id, {
        meetingId: value.id,
        revision: value.revision,
      });
      const pending = service.optIn(b.account.id, {
        meetingId: value.id,
        revision: value.revision,
      });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      await other.network.connectionAction(b.account.id, a.account.id, "block");
      release();
      await expect(pending).rejects.toMatchObject({ code: "not_connected" });
      const saved = (await service.list(a.account.id))[0];
      expect(saved.status).toBe("stale");
      expect(saved.options).toEqual([]);
    } finally {
      release();
      other.close();
    }
  });

  it("rejects a newly occupied slot before the second approval takes effect", async () => {
    await connectCalendar(a);
    await connectCalendar(b);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => calendarReply(init)),
    );
    let value = await calendarOptions();
    const chosen = value.options[0];
    value = await service.approve(a.account.id, {
      meetingId: value.id,
      revision: value.revision,
      optionId: chosen.id,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        calendarReply(init, [chosen]),
      ),
    );
    await expect(
      service.approve(b.account.id, {
        meetingId: value.id,
        revision: value.revision,
        optionId: chosen.id,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "availability_changed" }),
    );
    value = (await service.list(a.account.id))[0];
    expect(value.approvedUserIds).toEqual([]);
    expect(value.status).toBe("awaiting_permission");
  });
});
