import { z } from "zod";
import { Temporal } from "@js-temporal/polyfill";
import type { SharedEvent, SharedProfile, Visibility } from "./network";

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
};
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
    const date = Temporal.Instant.from(event.start)
      .toZonedDateTimeISO("America/Los_Angeles")
      .toPlainDate()
      .toString();
    return date >= start && date <= end;
  };
  const sharedEvents = (a.events ?? []).filter(
    (event) =>
      (b.events ?? []).some((other) => event.id === other.id) &&
      inOverlap(event),
  );
  const reunion = connected && sharedEvents.length > 0 && shared.length > 0;
  const professionalMatch =
    (complementary || collaboration) &&
    rolesCompatible &&
    forA.length > 0 &&
    forB.length > 0 &&
    shared.length > 0;
  if (!professionalMatch && !reunion) return null;
  const eventSuggestions = (b.events ?? [])
    .filter(
      (event) =>
        inOverlap(event) &&
        !sharedEvents.some((shared) => shared.id === event.id),
    )
    .slice(0, 3);
  const you = !professionalMatch
    ? "Reconnect at a shared event around your common professional interests."
    : complementary
      ? a.goal.type === "seeking_role"
        ? "Their stated hiring goal aligns with your search for a role."
        : "Their stated role search aligns with your hiring goal."
      : "Their experience supports your stated collaboration goal.";
  const them = !professionalMatch
    ? "They can continue a conversation with a connection who shares their interests."
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
        ? [`Both reported plans to attend ${sharedEvents[0].title}.`]
        : []),
    ],
    benefits: { you, them },
    signals: [...new Set([...shared, ...forA, ...forB])],
    overlap: { start, end },
    sharedEvents,
    eventSuggestions,
  };
}
