import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";

export const SF_TIMEZONE = "America/Los_Angeles" as const;
export const GOALS = [
  {
    value: "seeking_role",
    label: "Encontrar un rol",
    detail: "Conocer equipos que buscan un founding engineer.",
  },
  {
    value: "hiring",
    label: "Encontrar talento",
    detail: "Conocer a tu próximo founding engineer.",
  },
  {
    value: "customers",
    label: "Encontrar clientes",
    detail: "Explorar pilotos y posibles design partners.",
  },
  {
    value: "collaborators",
    label: "Conocer colaboradores",
    detail: "Conectar con personas con intereses afines.",
  },
] as const;

const text = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .min(min, message)
    .max(max, `Usa como máximo ${max} caracteres.`);
const date = z.iso.date({ error: "Introduce una fecha válida." });
const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Introduce una hora válida.");

export const profileSchema = z
  .object({
    name: text(2, 80, "Escribe el nombre que quieres usar."),
    bio: text(
      20,
      2000,
      "Cuéntanos un poco más sobre tu experiencia (al menos 20 caracteres).",
    ),
    offers: text(
      10,
      1000,
      "Describe qué puedes aportar (al menos 10 caracteres).",
    ),
  })
  .strict();

export const goalSchema = z
  .object({
    type: z.enum(["seeking_role", "hiring", "customers", "collaborators"], {
      error: "Elige un objetivo.",
    }),
    text: text(
      10,
      1000,
      "Describe qué te gustaría conseguir (al menos 10 caracteres).",
    ),
  })
  .strict();

export const windowSchema = z.object({ date, start: time, end: time }).strict();
export const commitmentSchema = windowSchema.extend({
  title: text(2, 120, "Añade un nombre para este compromiso."),
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
      windows: z.array(windowSchema).max(14, "Puedes añadir hasta 14 franjas."),
    })
    .strict(),
  commitments: z
    .object({
      status: z.enum(["unknown", "none", "provided"]),
      items: z
        .array(commitmentSchema)
        .max(12, "Puedes añadir hasta 12 compromisos."),
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
    issue(
      ["trip", "end"],
      "La salida debe ser el mismo día o después de la llegada.",
    );
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
      issue(
        group.path,
        "Añade al menos una franja o indica que todavía no lo sabes.",
      );
    if (group.status !== "provided" && group.rows.length)
      issue(group.path, "El estado elegido no puede incluir horarios.");
    const parsed: { start: number; end: number }[] = [];
    group.rows.forEach((row, index) => {
      if (row.date < value.trip.start || row.date > value.trip.end)
        issue(
          [...group.path, index, "date"],
          "Elige un día dentro de tu estancia.",
        );
      try {
        const slot = windowInstants(row);
        if (slot.end <= slot.start)
          issue(
            [...group.path, index, "end"],
            "La hora de fin debe ser posterior al inicio.",
          );
        if (
          parsed.some(
            (other) => slot.start < other.end && slot.end > other.start,
          )
        )
          issue(
            [...group.path, index, "start"],
            "Este horario se solapa con otro de la misma lista.",
          );
        parsed.push(slot);
      } catch {
        issue(
          [...group.path, index, "start"],
          "Esta hora no es inequívoca en SF por el cambio horario. Elige otra franja.",
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
      error: "Confirma que el resumen refleja tu situación.",
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
