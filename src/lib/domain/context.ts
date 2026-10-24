import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

export const SF_TIMEZONE = "America/Los_Angeles" as const;
export const GOALS = [
  {
    value: "seeking_role",
    label: "Find a role",
    detail: "Meet teams hiring a founding engineer.",
  },
  {
    value: "hiring",
    label: "Hire an engineer",
    detail: "Meet your next founding engineer.",
  },
  {
    value: "customers",
    label: "Find customers",
    detail: "Explore pilots and potential design partners.",
  },
  {
    value: "collaborators",
    label: "Find collaborators",
    detail: "Connect with people who share your interests.",
  },
] as const;

const text = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .min(min, message)
    .max(max, `Use no more than ${max} characters.`);
const date = z.iso.date({ error: "Enter a valid date." });
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Enter a valid time.");

export const profileSchema = z
  .object({
    name: text(2, 80, "Enter the name you want to use."),
    bio: text(20, 2000, "Describe your experience in at least 20 characters."),
    offers: text(
      10,
      1000,
      "Describe what you can offer in at least 10 characters.",
    ),
  })
  .strict();

export const goalSchema = z
  .object({
    type: z.enum(["seeking_role", "hiring", "customers", "collaborators"], {
      error: "Clarify your main goal.",
    }),
    text: text(10, 1000, "Describe your goal in at least 10 characters."),
  })
  .strict();

export const windowSchema = z.object({ date, start: time, end: time }).strict();
export const commitmentSchema = windowSchema.extend({
  title: text(2, 120, "Name this commitment."),
});
export type TimeWindow = z.infer<typeof windowSchema>;

// Reject nonexistent/ambiguous local times rather than silently changing the user's plan.
export function windowInstants(window: TimeWindow) {
  const instant = (value: string) =>
    Temporal.ZonedDateTime.from(`${window.date}T${value}[${SF_TIMEZONE}]`, {
      disambiguation: "reject",
    }).epochMilliseconds;
  return { start: instant(window.start), end: instant(window.end) };
}

export const tripSchema = z
  .object({
    city: z.literal("San Francisco"),
    start: date,
    end: date,
    timezone: z.literal(SF_TIMEZONE),
  })
  .strict();

const scheduleShape = {
  trip: tripSchema,
  availability: z
    .object({
      status: z.enum(["unknown", "provided"]),
      windows: z.array(windowSchema).max(14, "Add no more than 14 time slots."),
    })
    .strict(),
  commitments: z
    .object({
      status: z.enum(["unknown", "none", "provided"]),
      items: z
        .array(commitmentSchema)
        .max(12, "Add no more than 12 commitments."),
    })
    .strict(),
  preferences: z
    .object({
      meetingFormat: z.enum(["any", "small_groups", "one_to_one"]),
      budgetUsd: z.number().finite().min(0).max(10000).nullable(),
    })
    .strict(),
};

type Schedule = z.infer<z.ZodObject<typeof scheduleShape>>;
function validateSchedule(value: Schedule, ctx: z.RefinementCtx) {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  // Arrival/departure are inclusive calendar dates, so a one-day visit is valid.
  if (value.trip.end < value.trip.start)
    issue(["trip", "end"], "Departure must be on or after arrival.");
  const groups = [
    {
      path: ["availability", "windows"],
      rows: value.availability.windows,
      status: value.availability.status,
    },
    {
      path: ["commitments", "items"],
      rows: value.commitments.items,
      status: value.commitments.status,
    },
  ];
  for (const group of groups) {
    if (group.status === "provided" && !group.rows.length)
      issue(group.path, "Add a time slot or leave availability unknown.");
    if (group.status !== "provided" && group.rows.length)
      issue(group.path, "This status cannot include time slots.");
    const parsed: { start: number; end: number }[] = [];
    group.rows.forEach((row, index) => {
      if (row.date < value.trip.start || row.date > value.trip.end)
        issue(
          [...group.path, index, "date"],
          "Choose a date within your stay.",
        );
      try {
        const slot = windowInstants(row);
        if (slot.end <= slot.start)
          issue(
            [...group.path, index, "end"],
            "End time must be after start time.",
          );
        if (
          parsed.some(
            (other) => slot.start < other.end && slot.end > other.start,
          )
        )
          issue(
            [...group.path, index, "start"],
            "This time slot overlaps another in the same list.",
          );
        parsed.push(slot);
      } catch {
        issue(
          [...group.path, index, "start"],
          "This time is ambiguous or unavailable in SF due to daylight saving. Choose another time.",
        );
      }
    });
  }
}

export const scheduleSchema = z
  .object(scheduleShape)
  .strict()
  .superRefine(validateSchedule);
export const contextSchema = z
  .object({ profile: profileSchema, goal: goalSchema, ...scheduleShape })
  .strict()
  .superRefine(validateSchedule);
export type UserContext = z.infer<typeof contextSchema>;
export type GoalType = UserContext["goal"]["type"];

export const saveContextSchema = z
  .object({
    context: contextSchema,
    baseRevision: z.number().int().min(0),
    requestId: z.uuid(),
    confirmed: z.literal(true, {
      error: "Confirm that the profile reflects your situation.",
    }),
  })
  .strict();

export type ContextState = {
  context: UserContext | null;
  revision: number;
  confirmedAt: string | null;
  evidenceKind: "user_report" | null;
};
export type FieldErrors = Record<string, string>;
export function fieldErrors(error: z.ZodError): FieldErrors {
  return Object.fromEntries(
    error.issues.map((issue) => [issue.path.join("."), issue.message]),
  );
}

export function emptyContext(): UserContext {
  return {
    profile: { name: "", bio: "", offers: "" },
    goal: { type: "seeking_role", text: "" },
    trip: { city: "San Francisco", start: "", end: "", timezone: SF_TIMEZONE },
    availability: { status: "unknown", windows: [] },
    commitments: { status: "unknown", items: [] },
    preferences: { meetingFormat: "any", budgetUsd: null },
  };
}
