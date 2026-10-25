import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { SharedEvent, SharedProfile, Visibility } from "./network";
import { canonicalUrl } from "./event-discovery";

export const networkEventSchema = z
  .object({
    id: z.uuid().optional(),
    title: z.string().trim().min(3).max(160),
    url: z
      .url()
      .max(2000)
      .refine(
        (url) => new URL(url).protocol === "https:",
        "Use an HTTPS event link.",
      )
      .optional(),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    area: z.string().trim().max(80),
    visibility: z.enum(["private", "friends", "network"]),
    attendance: z.enum(["planned", "registered"]).optional(),
  })
  .strict()
  .refine((event) => {
    const duration = Date.parse(event.end) - Date.parse(event.start);
    return duration > 0 && duration <= 24 * 60 * 60 * 1000;
  }, "Choose an event of up to one day with an end after its start.");
export type NetworkEventInput = z.infer<typeof networkEventSchema>;
export type NetworkEvent = SharedEvent & {
  url?: string;
  visibility: Visibility;
  sourceRecommendationId?: string;
  sourceCheckedAt?: string;
  canonicalKey?: string;
  aliasUrls?: string[];
};
export const eventAttendanceSchema = z.object({
  action: z.literal("register"),
  recommendationId: z.string().min(1).max(500),
  discoveryCheckedAt: z.iso.datetime({ offset: true }),
  revision: z.number().int().positive(),
  visibility: z.enum(["private", "friends", "network"]),
}).strict();
export type EventAttendanceInput = z.infer<typeof eventAttendanceSchema>;

/** Provider aliases share an identity; generic query parameters may identify an event. */
export function canonicalEventUrl(value: string): string {
  const url = new URL(value);
  const provider = canonicalUrl(value);
  if (provider && provider.platform !== "web") return provider.url;
  url.hash = "";
  url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key))
      url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function canonicalEventDate(event: Pick<SharedEvent, "date" | "dateStatus" | "start">): string | null {
  if (event.dateStatus === "unconfirmed_year") return null;
  if (event.date) return event.date;
  if (!event.start) return null;
  return Temporal.Instant.from(event.start)
    .toZonedDateTimeISO("America/Los_Angeles")
    .toPlainDate().toString();
}

/** Only server-derived opaque aliases cross the authorized shared-event boundary. */
function sameSharedEvent(a: SharedEvent, b: SharedEvent): boolean {
  const keys = new Set([a.id, ...(a.canonicalKeys ?? [])]);
  return [b.id, ...(b.canonicalKeys ?? [])].some((key) => keys.has(key));
}
export type OpportunityView = {
  id: string;
  userId: string;
  name: string;
  score: number;
  reasons: string[];
  benefits: { you: string; them: string };
  signals: string[];
  overlap: { start: string; end: string };
  sharedEvents: SharedEvent[];
  eventSuggestions: SharedEvent[];
  createdAt: string;
  source: "user_report" | "demo";
  connected: boolean;
  goal?: SharedProfile["goal"];
};
export type MatchEvidence = Omit<
  OpportunityView,
  "id" | "userId" | "name" | "createdAt" | "connected" | "source"
>;

// Deliberately small vocabulary: explicit terms, not inferred skills or hiring intent.
const terms: Record<string, RegExp> = {
  AI: /\b(ai|artificial intelligence|machine learning|llm|llms)\b/i,
  agents: /\bagents?\b/i,
  infrastructure: /\binfrastructure\b/i,
  algorithms: /\b(algorithms?|icpc|competitive programming)\b/i,
  TypeScript: /\btypescript\b/i,
  Python: /\bpython\b/i,
  "product engineering": /\b(product|production|software)\b/i,
  "early-stage teams":
    /\b(startups?|founding|founder|early.stage|cofounder)\b/i,
};
const professional = (person: SharedProfile) =>
  `${person.profile?.bio ?? ""} ${person.profile?.offers ?? ""}`;
const signalsIn = (text: string) =>
  Object.entries(terms)
    .filter(([, rule]) => rule.test(text))
    .map(([term]) => term);

function role(text: string) {
  if (/\b(sales|account executive)\b/i.test(text)) return "sales";
  if (/\b(marketing|marketer)\b/i.test(text)) return "marketing";
  if (/\bdesigner\b/i.test(text)) return "design";
  if (/\b(cto|chief technology officer)\b/i.test(text)) return "cto";
  if (/\bfounding engineer\b/i.test(text)) return "founding_engineer";
  if (
    /\b(engineer|engineering|developer|technical role|technical lead)\b/i.test(
      text,
    )
  )
    return "engineering";
  return null;
}

/** Uses only pre-authorized projections. Score is a heuristic, not a probability. */
export function rankPeople(
  a: SharedProfile,
  b: SharedProfile,
  today: string,
  connected = false,
): MatchEvidence | null {
  if (!a.profile || !b.profile || !a.goal || !b.goal || !a.trip || !b.trip)
    return null;
  if (a.trip.city !== b.trip.city) return null;
  const start = [a.trip.start, b.trip.start, today].sort().at(-1)!;
  const end = [a.trip.end, b.trip.end].sort()[0];
  if (start > end) return null;
  const complementary =
    (a.goal.type === "hiring" && b.goal.type === "seeking_role") ||
    (b.goal.type === "hiring" && a.goal.type === "seeking_role");
  let rolesCompatible = true;
  if (complementary) {
    const roleA = role(a.goal.text),
      roleB = role(b.goal.text);
    const technical = ["engineering", "founding_engineer", "cto"];
    if (
      !roleA ||
      !roleB ||
      (roleA !== roleB &&
        !(
          technical.includes(roleA) &&
          technical.includes(roleB) &&
          [roleA, roleB].includes("engineering")
        ))
    )
      rolesCompatible = false;
  }
  const collaboration =
    a.goal.type === "collaborators" && b.goal.type === "collaborators";
  const shared = signalsIn(professional(a)).filter((term) =>
    signalsIn(professional(b)).includes(term),
  );
  const forA = signalsIn(a.goal.text).filter((term) =>
    signalsIn(professional(b)).includes(term),
  );
  const forB = signalsIn(b.goal.text).filter((term) =>
    signalsIn(professional(a)).includes(term),
  );
  const inOverlap = (event: SharedEvent) => {
    const date = canonicalEventDate(event);
    return date !== null && date >= start && date <= end;
  };
  const sharedEvents = (a.events ?? []).filter(
    (event) =>
      (b.events ?? []).some((other) => sameSharedEvent(event, other) && inOverlap(other)) &&
      inOverlap(event),
  );
  const reunion = connected && sharedEvents.length > 0 && shared.length > 0;
  const registeredTogether = shared.length > 0 && sharedEvents.some((event) =>
    event.attendance === "registered" &&
    b.events?.some((other) => sameSharedEvent(event, other) && inOverlap(other) && other.attendance === "registered"),
  );
  const professionalMatch =
    (complementary || collaboration) &&
    rolesCompatible &&
    forA.length > 0 &&
    forB.length > 0 &&
    shared.length > 0;
  if (!professionalMatch && !reunion && !registeredTogether) return null;
  const eventSuggestions = (b.events ?? [])
    .filter(
      (event) =>
        inOverlap(event) &&
        !sharedEvents.some((shared) => sameSharedEvent(shared, event)),
    )
    .slice(0, 3);
  const you = !professionalMatch
    ? connected
      ? "Reconnect at a shared event around your common professional interests."
      : "Meet someone who also reported registering for this event and shares your professional interests."
    : complementary
      ? a.goal.type === "seeking_role"
        ? "Their stated hiring goal aligns with your search for a role."
        : "Their stated role search aligns with your hiring goal."
      : "Their experience supports your stated collaboration goal.";
  const them = !professionalMatch
    ? connected
      ? "They can continue a conversation with a connection who shares their interests."
      : "They can exchange experience with someone planning the same event who shares their interests."
    : complementary
      ? a.goal.type === "seeking_role"
        ? "Your experience is relevant to their stated hiring needs."
        : "Your hiring goal offers an opportunity they are seeking."
      : "Your experience supports their stated collaboration goal.";
  return {
    score: Math.min(
      95,
      (professionalMatch && complementary ? 65 : 50) +
        Math.min(shared.length, 3) * 5 +
        (sharedEvents.length ? 10 : 0),
    ),
    reasons: [
      you,
      `Both profiles mention ${shared.join(", ")}.`,
      "Your stays overlap in San Francisco.",
      ...(sharedEvents.length
        ? [sharedEvents[0].attendance === "registered" && b.events?.some((event) =>
            sameSharedEvent(sharedEvents[0], event) && event.attendance === "registered")
          ? `Both reported registering for ${sharedEvents[0].title}.`
          : `Both reported plans to attend ${sharedEvents[0].title}.`]
        : []),
    ],
    benefits: { you, them },
    signals: [...new Set([...shared, ...forA, ...forB])],
    overlap: { start, end },
    sharedEvents,
    eventSuggestions,
  };
}
