import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { SF_TIMEZONE } from "./context";

export const CALENDAR_FRESH_MS = 5 * 60 * 1000;
export const CALENDAR_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
] as const;
export const CALENDAR_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned";

export type MeetingCalendarPublication = {
  status: "publishing" | "scheduled" | "conference_pending" | "failed";
  organizerUserId: string;
  eventId: string;
  conferenceRequestId: string;
  /** Kept server-side; a calendar ID can contain the owner's private email. */
  calendarId: string;
  eventUrl: string | null;
  meetUrl: string | null;
  error: string | null;
  updatedAt: string;
};

export type CalendarOption = {
  id: string;
  name: string;
  primary: boolean;
  timezone: string;
};
export type CalendarWindow = {
  startDate: string;
  endDate: string;
  timeMin: string;
  timeMax: string;
};
export type BusyInterval = { start: string; end: string };
export type AvailabilitySnapshot = {
  window: CalendarWindow;
  calendarIds: string[];
  checkedAt: string;
  busy: BusyInterval[];
};
export type CalendarIssue =
  | "needs_reconnect"
  | "sync_failed"
  | "calendar_unavailable"
  | null;
export type CalendarConnection = {
  subject: string;
  email: string;
  encryptedTokens: string;
  calendars: CalendarOption[];
  selectedIds: string[];
  snapshot: AvailabilitySnapshot | null;
  issue: CalendarIssue;
};
export type CalendarRecord = {
  revision: number;
  connection: CalendarConnection | null;
};
export type CalendarStatus = {
  configured: boolean;
  status:
    | "not_connected"
    | "connected"
    | "synced"
    | "needs_reconnect"
    | "sync_failed";
  revision: number;
  email: string | null;
  calendars: CalendarOption[];
  selectedIds: string[];
  window: CalendarWindow | null;
  checkedAt: string | null;
  availabilityReady: boolean;
  profileReady: boolean;
  onboardingComplete: boolean;
  issue: CalendarIssue;
  meetingPublishingReady?: boolean;
};

export const calendarActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }).strict(),
  z
    .object({
      action: z.literal("select"),
      revision: z.number().int().min(0),
      calendarIds: z.array(z.string().min(1).max(1024)).min(1).max(50),
    })
    .strict(),
  z
    .object({
      action: z.literal("disconnect"),
      revision: z.number().int().min(0),
    })
    .strict(),
]);

export function calendarWindow(
  startDate: string,
  endDate: string,
): CalendarWindow | null {
  if (
    !z.iso.date().safeParse(startDate).success ||
    !z.iso.date().safeParse(endDate).success ||
    endDate < startDate
  )
    return null;
  const start = Temporal.PlainDate.from(startDate);
  const end = Temporal.PlainDate.from(endDate).add({ days: 1 });
  return {
    startDate,
    endDate,
    timeMin: start
      .toZonedDateTime({ timeZone: SF_TIMEZONE, plainTime: "00:00" })
      .toInstant()
      .toString(),
    timeMax: end
      .toZonedDateTime({ timeZone: SF_TIMEZONE, plainTime: "00:00" })
      .toInstant()
      .toString(),
  };
}

export function snapshotIsFresh(
  connection: CalendarConnection,
  window: CalendarWindow | null,
  now = Date.now(),
) {
  const snapshot = connection.snapshot;
  if (
    !window ||
    !snapshot ||
    connection.issue ||
    !connection.selectedIds.length
  )
    return false;
  const age = now - Date.parse(snapshot.checkedAt);
  return (
    age >= 0 &&
    age < CALENDAR_FRESH_MS &&
    snapshot.window.timeMin === window.timeMin &&
    snapshot.window.timeMax === window.timeMax &&
    [...snapshot.calendarIds].sort().join("\n") ===
      [...connection.selectedIds].sort().join("\n")
  );
}

export function mergeBusy(
  intervals: BusyInterval[],
  window: CalendarWindow,
): BusyInterval[] {
  const min = Date.parse(window.timeMin),
    max = Date.parse(window.timeMax);
  const sorted = intervals
    .map((value) => ({
      start: Math.max(min, Date.parse(value.start)),
      end: Math.min(max, Date.parse(value.end)),
    }))
    .filter((value) => value.start < value.end)
    .sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const current of sorted) {
    const last = merged.at(-1);
    if (last && current.start <= last.end)
      last.end = Math.max(last.end, current.end);
    else merged.push({ ...current });
  }
  return merged.map((value) => ({
    start: new Date(value.start).toISOString(),
    end: new Date(value.end).toISOString(),
  }));
}
