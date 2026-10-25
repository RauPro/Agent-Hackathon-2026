import { z } from "zod";
import { windowInstants } from "./context";
import type { MeetingCalendarPublication } from "./calendar";

export const meetingSlotSchema = z
  .object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine((slot) => {
    const duration = Date.parse(slot.end) - Date.parse(slot.start);
    return duration > 0 && duration <= 24 * 60 * 60 * 1000;
  }, "Choose a valid availability window of at most one day.");
export type MeetingSlot = z.infer<typeof meetingSlotSchema>;

export const proposeMeetingSchema = z
  .object({
    toUserId: z.uuid(),
    requestId: z.uuid(),
    purpose: z.string().trim().min(5).max(300),
    location: z.string().trim().min(2).max(240).optional(),
    modality: z.enum(["in_person", "online"]).optional(),
    sharedArea: z.string().trim().min(2).max(80).optional(),
    eventId: z.string().trim().min(1).max(240).optional(),
    authorizeAvailability: z.boolean().optional(),
  })
  .strict();
export const meetingRevisionSchema = z
  .object({
    meetingId: z.uuid(),
    revision: z.number().int().min(1),
  })
  .strict();
export const meetingOptInSchema = meetingRevisionSchema.extend({
  manualSlots: z.array(meetingSlotSchema).min(1).max(14).optional(),
});
export const meetingApprovalSchema = meetingRevisionSchema.extend({
  optionId: z.string().min(1).max(100),
});
export const meetingPreferencesSchema = meetingRevisionSchema.extend({
  preferredWindows: z.array(meetingSlotSchema).min(1).max(14),
});
export const meetingLocationSchema = meetingRevisionSchema.extend({
  location: z.string().trim().min(2).max(240),
});
export const meetingActionSchema = z.discriminatedUnion("action", [
  proposeMeetingSchema.extend({ action: z.literal("propose") }),
  meetingOptInSchema.extend({ action: z.literal("opt_in") }),
  meetingApprovalSchema.extend({ action: z.literal("approve") }),
  meetingPreferencesSchema.extend({ action: z.literal("suggest_times") }),
  meetingLocationSchema.extend({ action: z.literal("set_location") }),
  meetingRevisionSchema.extend({ action: z.literal("publish") }),
  meetingRevisionSchema.extend({ action: z.literal("withdraw") }),
]);

export type MeetingOption = MeetingSlot & { id: string };
export type MeetingStatus =
  | "awaiting_permission"
  | "options_ready"
  | "needs_user_input"
  | "confirmed"
  | "withdrawn"
  | "expired"
  | "stale";
export type MeetingActivityEntry = {
  id: string;
  at: string;
  kind:
    | "proposed"
    | "availability_consented"
    | "options_ready"
    | "no_common_time"
    | "option_approved"
    | "option_counterproposed"
    | "confirmed"
    | "withdrawn"
    | "stale"
    | "expired"
    | "availability_failed"
    | "agent_slots_proposed"
    | "agent_slots_checked"
    | "agent_counterproposed"
    | "preferences_updated"
    | "location_updated"
    | "escalated";
  actorUserId?: string;
  optionId?: string;
  optionCount?: number;
  slots?: MeetingSlot[];
};
export type MeetingView = {
  id: string;
  createdAt: string;
  activity: MeetingActivityEntry[];
  revision: number;
  initiatorId: string;
  participants: { userId: string; name: string }[];
  purpose: string;
  location: string | null;
  modality?: "in_person" | "online";
  sharedArea?: string | null;
  suggestedArea?: string | null;
  ownPreferredWindows?: MeetingSlot[];
  sharedEvent?: {
    id: string;
    title: string;
    start: string;
    end: string;
  } | null;
  nextAction?: {
    kind:
      | "authorize_availability"
      | "provide_availability"
      | "suggest_times"
      | "reconnect_calendar";
    prompt: string;
  } | null;
  status: MeetingStatus;
  durationMinutes: 30;
  timezone: "America/Los_Angeles";
  options: MeetingOption[];
  selectedOptionId: string | null;
  consentedUserIds: string[];
  approvedUserIds: string[];
  manualAvailabilityNeeded: boolean;
  availabilitySource: "google" | "manual" | "mixed" | null;
  checkedAt: string | null;
  expiresAt: string;
  calendarStatus: "not_ready" | "export_available";
  calendarPublication?: Omit<
    MeetingCalendarPublication,
    "calendarId" | "conferenceRequestId"
  > | null;
  error: string | null;
};

/** Interpret manual meeting windows in SF, independent of the browser timezone. */
export function manualMeetingSlot(
  date: string,
  start: string,
  end: string,
): MeetingSlot {
  const slot = windowInstants({ date, start, end });
  return meetingSlotSchema.parse({
    start: new Date(slot.start).toISOString(),
    end: new Date(slot.end).toISOString(),
  });
}
