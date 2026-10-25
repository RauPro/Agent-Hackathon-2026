import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  CalendarConnection,
  MeetingCalendarPublication,
} from "@/lib/domain/calendar";
import { openCalendarData, sealCalendarData } from "./calendar-crypto";
import {
  CalendarError,
  createOrGetGoogleMeeting,
  getGoogleMeeting,
  googleCalendarConfig,
  hasCalendarWriteScope,
  refreshGoogleTokens,
  tokenDataSchema,
} from "./google-calendar";
import type { ContextStore } from "./store";

export type ApprovedMeetingCalendarInput = {
  id: string;
  purpose: string;
  location: string | null;
  modality: "in_person" | "online";
  participants: string[];
  names: Record<string, string>;
  slot: { start: string; end: string };
  availabilityRevisions?: Record<string, number>;
};

async function organizerCalendar(store: ContextStore, actorId: string) {
  const row = (await store.network.db
    .prepare(
      "SELECT u.profile_id, c.revision, c.connection_json FROM users u LEFT JOIN calendar_connections c ON c.session_id = u.profile_id WHERE u.id = ?",
    )
    .get(actorId)) as
    | {
        profile_id: string;
        revision: number | null;
        connection_json: string | null;
      }
    | undefined;
  if (!row?.connection_json) throw new CalendarError("needs_reconnect");
  const connection = JSON.parse(row.connection_json) as CalendarConnection;
  let tokens;
  try {
    tokens = tokenDataSchema.parse(
      openCalendarData(connection.encryptedTokens, row.profile_id),
    );
  } catch {
    throw new CalendarError("needs_reconnect");
  }
  if (!hasCalendarWriteScope(tokens.scopes))
    throw new CalendarError("needs_upgrade");
  const primary = connection.calendars.find((calendar) => calendar.primary);
  if (!primary) throw new CalendarError("calendar_unavailable");
  return {
    owner: row.profile_id,
    revision: row.revision!,
    connection,
    tokens,
    calendarId: primary.id,
  };
}

async function requireApproval(
  store: ContextStore,
  actorId: string,
  input: ApprovedMeetingCalendarInput,
) {
  const row = (await store.network.db
    .prepare(
      "SELECT state_json FROM meetings WHERE id = ? AND (first_user_id = ? OR second_user_id = ?)",
    )
    .get(input.id, actorId, actorId)) as { state_json: string } | undefined;
  const parsed =
    row &&
    z
      .object({
        status: z.literal("confirmed"),
        participants: z.array(z.string()).length(2),
        approvals: z.record(z.string(), z.string()),
        selectedOptionId: z.string(),
        options: z.array(
          z.object({ id: z.string(), start: z.string(), end: z.string() }),
        ),
        purpose: z.string(),
        location: z.string().nullable(),
        modality: z.enum(["in_person", "online"]).optional(),
        contextRevisions: z.record(z.string(), z.number().int()),
        relationshipRevision: z.number().int(),
        sharedEvent: z.object({ id: z.string() }).nullable().optional(),
      })
      .safeParse(JSON.parse(row.state_json));
  if (!parsed?.success) throw new CalendarError("approval_required");
  const value = parsed.data;
  const slot = value.options.find(
    (option) => option.id === value.selectedOptionId,
  );
  if (
    !slot ||
    slot.start !== input.slot.start ||
    slot.end !== input.slot.end ||
    value.purpose !== input.purpose ||
    value.location !== input.location ||
    (value.modality ?? "in_person") !== input.modality ||
    value.participants.slice().sort().join() !==
      input.participants.slice().sort().join() ||
    !value.participants.every(
      (id) => value.approvals[id] === value.selectedOptionId,
    ) ||
    !(await store.network.isConnected(
      value.participants[0],
      value.participants[1],
    )) ||
    (await store.network.blocked(value.participants[0], value.participants[1]))
  )
    throw new CalendarError("approval_required");
  if (
    (await store.network.relationshipRevision(
      value.participants[0],
      value.participants[1],
    )) !== value.relationshipRevision
  )
    throw new CalendarError("approval_required");
  for (const id of value.participants) {
    const profile = await store.network.profile(id);
    if (
      !profile.context ||
      !profile.confirmedAt ||
      profile.revision !== value.contextRevisions[id]
    )
      throw new CalendarError("approval_required");
  }
  if (value.sharedEvent) {
    const [a, b] = await Promise.all([
      store.network.project(value.participants[1], value.participants[0]),
      store.network.project(value.participants[0], value.participants[1]),
    ]);
    const event = a.events?.find((item) => item.id === value.sharedEvent!.id);
    const keys = new Set(
      event ? [event.id, ...(event.canonicalKeys ?? [])] : [],
    );
    if (
      !event ||
      !b.events?.some((item) =>
        [item.id, ...(item.canonicalKeys ?? [])].some((key) => keys.has(key)),
      )
    )
      throw new CalendarError("approval_required");
  }
}

/** Validate write access before the caller records a publishing attempt. */
export async function prepareMeetingCalendar(
  store: ContextStore,
  actorId: string,
  input: ApprovedMeetingCalendarInput,
  previous?: MeetingCalendarPublication | null,
): Promise<MeetingCalendarPublication> {
  await requireApproval(store, actorId, input);
  if (!googleCalendarConfig()) throw new CalendarError("not_configured");
  if (previous && previous.organizerUserId !== actorId)
    throw new CalendarError("account_changed");
  const calendar = await organizerCalendar(store, actorId);
  if (previous && previous.calendarId !== calendar.calendarId)
    throw new CalendarError("account_changed");
  const eventId = createHash("sha256")
    .update(`sidekick:meeting:${input.id}`)
    .digest("hex");
  const conferenceRequestId = createHash("sha256")
    .update(`sidekick:conference:${input.id}`)
    .digest("hex");
  return {
    status: "publishing",
    organizerUserId: actorId,
    calendarId: calendar.calendarId,
    eventId,
    conferenceRequestId,
    eventUrl: previous?.eventUrl ?? null,
    meetUrl: previous?.meetUrl ?? null,
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Only called by the explicit publishing action after both human approvals. */
export async function publishApprovedMeeting(
  store: ContextStore,
  actorId: string,
  input: ApprovedMeetingCalendarInput,
  prepared: MeetingCalendarPublication,
): Promise<MeetingCalendarPublication> {
  return (await meetingCalendarOperation(
    store,
    actorId,
    input,
    prepared,
    true,
  ))!;
}

/** Look up a prior uncertain attempt before testing availability again. */
export async function inspectPublishedMeeting(
  store: ContextStore,
  actorId: string,
  input: ApprovedMeetingCalendarInput,
  prepared: MeetingCalendarPublication,
): Promise<MeetingCalendarPublication | null> {
  return meetingCalendarOperation(store, actorId, input, prepared, false);
}

async function meetingCalendarOperation(
  store: ContextStore,
  actorId: string,
  input: ApprovedMeetingCalendarInput,
  prepared: MeetingCalendarPublication,
  create: boolean,
): Promise<MeetingCalendarPublication | null> {
  let calendar = await organizerCalendar(store, actorId);
  if (
    create &&
    input.availabilityRevisions &&
    calendar.revision !== input.availabilityRevisions[actorId]
  )
    throw new CalendarError("calendar_changed");
  if (
    prepared.organizerUserId !== actorId ||
    prepared.calendarId !== calendar.calendarId
  )
    throw new CalendarError("account_changed");
  const leaseKey = `calendar:${calendar.owner}`;
  const lease = await store.network.db.acquireLease(leaseKey, 35_000);
  if (!lease) throw new CalendarError("busy");
  try {
    calendar = await organizerCalendar(store, actorId);
    if (
      create &&
      input.availabilityRevisions &&
      calendar.revision !== input.availabilityRevisions[actorId]
    )
      throw new CalendarError("calendar_changed");
    if (prepared.calendarId !== calendar.calendarId)
      throw new CalendarError("account_changed");
    const signal = AbortSignal.timeout(25_000);
    if (calendar.tokens.expiresAt < Date.now() + 60_000) {
      const tokens = await refreshGoogleTokens(calendar.tokens, signal);
      if (!hasCalendarWriteScope(tokens.scopes))
        throw new CalendarError("needs_upgrade");
      const changed = await store.network.db
        .prepare(
          "UPDATE calendar_connections SET revision = revision + 1, connection_json = ? WHERE session_id = ? AND revision = ?",
        )
        .run(
          JSON.stringify({
            ...calendar.connection,
            encryptedTokens: sealCalendarData(tokens, calendar.owner),
          }),
          calendar.owner,
          calendar.revision,
        );
      if (changed.changes !== 1) throw new CalendarError("calendar_changed");
      calendar.tokens = tokens;
      calendar.revision += 1;
    }
    const attendees: string[] = [];
    for (const id of input.participants) {
      const row = (await store.network.db
        .prepare("SELECT email FROM users WHERE id = ?")
        .get(id)) as { email: string } | undefined;
      if (!row || !z.email().safeParse(row.email).success)
        throw new CalendarError("approval_required");
      if (row.email.toLowerCase() !== calendar.connection.email.toLowerCase())
        attendees.push(row.email);
    }
    await requireApproval(store, actorId, input);
    const current = await organizerCalendar(store, actorId);
    if (
      current.revision !== calendar.revision ||
      current.calendarId !== prepared.calendarId
    )
      throw new CalendarError("calendar_changed");
    const googleInput = {
      meetingId: input.id,
      calendarId: prepared.calendarId,
      eventId: prepared.eventId,
      conferenceRequestId: prepared.conferenceRequestId,
      title: input.purpose,
      location: input.location,
      start: input.slot.start,
      end: input.slot.end,
      online: input.modality === "online",
      attendees,
    };
    const beforeInsert = async () => {
      await requireApproval(store, actorId, input);
      const current = await organizerCalendar(store, actorId);
      if (
        current.revision !== calendar.revision ||
        current.calendarId !== prepared.calendarId
      )
        throw new CalendarError("calendar_changed");
      if (input.availabilityRevisions) {
        for (const id of input.participants) {
          const row = (await store.network.db
            .prepare(
              "SELECT c.revision, c.connection_json FROM users u LEFT JOIN calendar_connections c ON c.session_id = u.profile_id WHERE u.id = ?",
            )
            .get(id)) as
            | { revision: number | null; connection_json: string | null }
            | undefined;
          const expected =
            id === actorId
              ? calendar.revision
              : input.availabilityRevisions[id];
          if ((row?.revision ?? 0) !== expected)
            throw new CalendarError("calendar_changed");
        }
      }
    };
    const event = create
      ? await createOrGetGoogleMeeting(
          calendar.tokens.accessToken,
          googleInput,
          signal,
          beforeInsert,
        )
      : await getGoogleMeeting(
          calendar.tokens.accessToken,
          googleInput,
          signal,
        );
    if (!event) return null;
    return {
      ...prepared,
      status:
        event.conferenceStatus === "pending"
          ? "conference_pending"
          : "scheduled",
      eventUrl: event.eventUrl,
      meetUrl: event.meetUrl,
      error:
        event.conferenceStatus === "failure"
          ? "The calendar invitation was created, but Google could not create a Meet link. Open the event to add a video link."
          : null,
      updatedAt: new Date().toISOString(),
    };
  } finally {
    await store.network.db.releaseLease(leaseKey, lease);
  }
}
