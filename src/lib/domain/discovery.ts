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
  "voice agents": /\b(?:voice[- ]agents?|agent[- ]voice)\b/i,
  infrastructure: /\binfrastructure\b/i,
  algorithms: /\b(algorithms?|icpc|competitive programming)\b/i,
  TypeScript: /\btypescript\b/i,
  Python: /\bpython\b/i,
  "product engineering": /\b(product|production|software)\b/i,
  "early-stage teams":
    /\b(startups?|founding|founder|early.stage|cofounder)\b/i,
  "construction / AEC": /\b(construction|contech|aec|bim|revit|built environment|architecture firms?|general contractors?)\b/i,
  robotics: /\b(robotics|robotic|warehouse automation)\b/i,
  healthcare: /\b(healthcare|health care|clinical|medical|patient care)\b/i,
  "climate / energy": /\b(climate tech|climatetech|clean energy|renewable energy|decarbonization)\b/i,
  fintech: /\b(fintech|financial technology|banking|payments)\b/i,
  education: /\b(edtech|education technology|learning platforms?)\b/i,
};
const sectors = new Set(["construction / AEC", "robotics", "healthcare", "climate / energy", "fintech", "education"]);
const focused = new Set([...sectors, "agents", "voice agents", "infrastructure", "algorithms"]);
// Conservatively exclude negated or historical clauses instead of inferring active intent.
const inactive = /\b(?:not|no|never|without|don't|doesn't|isn't|aren't|won't|can't|cannot|former|formerly|previously|used to|rather than|instead of|avoid|avoiding|decline|declining|exclude|excluding|uninterested)\b/i;
const uncertainOrOther = /\b(?:might|maybe|may|if|unless)\b|\b(?:my|our) (?:friend|client|colleague)\b|^\s*(?:he|she|they)\b/i;
const clauses = (text: string) => text.replace(/[’‘]/g, "'").split(/[.!?;\n]+|\b(?:but|however|whereas)\b/i);
const rejects = (text: string, topic: RegExp) => clauses(text).some((clause) => inactive.test(clause) && topic.test(clause));
const positiveText = (text: string) => clauses(text)
  .filter((clause) => !inactive.test(clause) && !uncertainOrOther.test(clause))
  .map((clause) => clause.trim()).filter(Boolean)
  .join(". ");
const professional = (person: SharedProfile) =>
  positiveText(`${person.profile?.bio ?? ""}. ${person.profile?.offers ?? ""}`);
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

function seeksInvestment(goal: string) {
  return /\b(?:rais(?:e|ing)|seek(?:ing)?|looking for|find|secure|attract)\b.{0,80}\b(?:capital|funding|investment|financing|seed round)\b/i.test(goal) ||
    /\b(?:meet|connect|find|seek(?:ing)?|looking for)\b.{0,80}\b(?:investors?|venture capital(?:ists)?|vcs?|angels?)\b/i.test(goal) ||
    /(?:^|\.\s*)(?:(?:i am|i'm|we are|currently|actively)\s+)*fundraising\b/i.test(goal);
}

function investorProfile(profile: string) {
  return /(?:^|\.\s*)(?:(?:i am|i'm|we are|an?|the)\s+)*(?:(?:angel|venture capital|venture|seed|pre-seed|early-stage|construction|contech|aec|climate|fintech|healthcare|technology|startup|ai)\s+){0,4}(?:investor|venture capitalist|vc)\b/i.test(profile) ||
    /\b(?:i|we|our fund|our firm)\s+(?:(?:currently|actively)\s+)?(?:invest|invests|back|backs)\s+in\b/i.test(profile);
}

function seeksStartups(goal: string) {
  return /\b(?:meet|find|connect|discover|evaluate|explore|back|fund|invest|support|source|identify|seek|seeking|looking for)\b.{0,90}\b(?:startups?|founders?|companies|teams|ventures|investment opportunities)\b/i.test(goal);
}

function offersProduct(profile: string) {
  return /\b(?:build|building|develop|developing|ship|shipping|create|creating|sell|selling|founder|cofounder)\b.{0,90}\b(?:tools?|products?|software|platforms?|systems?|solutions?|apps?|automation)\b/i.test(profile);
}

function seeksCustomers(goal: string) {
  return /\b(?:find|seek|seeking|meet|recruit|looking for|run|launch|secure|work with)\b.{0,90}\b(?:customers?|design partners?|pilots?|pilot partners?|buyers?)\b/i.test(goal);
}

function seeksSolutions(goal: string) {
  return /\b(?:find|seek|seeking|looking for|evaluate|evaluating|test|testing|try|pilot|adopt|explore|compare)\b.{0,90}\b(?:tools?|software|products?|platforms?|solutions?|automation|systems?)\b/i.test(goal);
}

type ReciprocalIntent = "fundraising" | "investing" | "customers" | "evaluating" | "technical_exchange" | "technical_collaboration";
function sectorFocus(person: SharedProfile) {
  const context = `${professional(person)}. ${positiveText(person.goal!.text)}`;
  const explicit = [...context.matchAll(/\b(?:focus(?:ed|es)?(?: exclusively| only)? on|exclusively|only)\s+([^.;]+)/gi)]
    .flatMap((match) => signalsIn(match[1]).filter((signal) => sectors.has(signal)));
  return explicit.length ? explicit : signalsIn(context).filter((signal) => sectors.has(signal));
}
function compatibleSectorFocus(a: SharedProfile, b: SharedProfile) {
  const sectorsA = sectorFocus(a), sectorsB = sectorFocus(b);
  return !(sectorsA.length && sectorsB.length && !sectorsA.some((sector) => sectorsB.includes(sector))) &&
    !sectorsB.some((sector) => rejects(a.goal!.text, terms[sector])) &&
    !sectorsA.some((sector) => rejects(b.goal!.text, terms[sector]));
}
function reciprocalIntent(a: SharedProfile, b: SharedProfile, shared: string[]): ReciprocalIntent | null {
  const specificShared = shared.filter((signal) => focused.has(signal));
  if (!specificShared.length || !compatibleSectorFocus(a, b)) return null;
  const goalA = positiveText(a.goal!.text), goalB = positiveText(b.goal!.text);
  // A short goal may rely on the already stated domain. An explicitly different
  // target sector must not be replaced by an earlier area of experience.
  for (const goal of [goalA, goalB]) {
    const targetSectors = signalsIn(goal).filter((signal) => sectors.has(signal));
    if (targetSectors.length && !targetSectors.some((signal) => specificShared.includes(signal))) return null;
    const targetTopics = signalsIn(goal).filter((signal) => focused.has(signal));
    if (targetTopics.length && !targetTopics.some((signal) => specificShared.includes(signal))) return null;
  }
  const profileA = professional(a), profileB = professional(b);
  const funding = /\b(?:fundrais\w*|funding|capital|investment|investors?|vcs?)\b/i;
  const investing = /\b(?:invest(?:or|ors|ing|s)?|venture capital(?:ist)?|vcs?)\b/i;
  const customers = /\b(?:customers?|design partners?|pilots?|buyers?)\b/i;
  const solutions = /\b(?:tools?|software|products?|platforms?|solutions?|automation|systems?)\b/i;
  const investorA = !rejects(`${a.profile!.bio}. ${a.profile!.offers}. ${a.goal!.text}`, investing) && investorProfile(profileA) && seeksStartups(goalA);
  const investorB = !rejects(`${b.profile!.bio}. ${b.profile!.offers}. ${b.goal!.text}`, investing) && investorProfile(profileB) && seeksStartups(goalB);
  if (!rejects(a.goal!.text, funding) && seeksInvestment(goalA) && investorB) return "fundraising";
  if (!rejects(b.goal!.text, funding) && seeksInvestment(goalB) && investorA) return "investing";
  if (!rejects(a.goal!.text, customers) && !rejects(b.goal!.text, solutions) && offersProduct(profileA) && seeksCustomers(goalA) && !seeksCustomers(goalB) && seeksSolutions(goalB)) return "customers";
  if (!rejects(b.goal!.text, customers) && !rejects(a.goal!.text, solutions) && offersProduct(profileB) && seeksCustomers(goalB) && !seeksCustomers(goalA) && seeksSolutions(goalA)) return "evaluating";
  return null;
}

function technicalExchange(a: SharedProfile, b: SharedProfile, shared: string[], forA: string[], forB: string[]): ReciprocalIntent | null {
  const seeker = a.goal!.type === "seeking_role" && b.goal!.type === "collaborators" ? a
    : b.goal!.type === "seeking_role" && a.goal!.type === "collaborators" ? b : null;
  if (!seeker) return null;
  const collaborator = seeker === a ? b : a;
  const topics = shared.filter((signal) => focused.has(signal));
  if (!topics.some((topic) => forA.includes(topic)) || !topics.some((topic) => forB.includes(topic))) return null;
  if (!compatibleSectorFocus(a, b)) return null;
  const networking = /\b(?:collaborat\w*|partnerships?|networking|meet(?:ing)?|connect\w*|exchanges?|conversations?)\b/i;
  if ([a, b].some((person) => rejects(person.goal!.text, networking)) ||
    /\bonly\b.{0,45}\b(?:jobs?|roles?|employment|paid work|positions?)\b/i.test(seeker.goal!.text)) return null;
  const goal = positiveText(collaborator.goal!.text);
  const wantsExchange = /\b(?:meet|connect|learn from|exchange|discuss|collaborate with)\b.{0,90}\b(?:engineers?|developers?|builders?|people building|people developing|teams building|teams developing)\b/i.test(goal) ||
    /\b(?:explore|find|seek|seeking|build)\b.{0,60}\btechnical (?:partnerships?|collaboration|exchange)\b/i.test(goal);
  return wantsExchange ? seeker === a ? "technical_exchange" : "technical_collaboration" : null;
}

const intentBenefits: Record<ReciprocalIntent, { you: string; them: string }> = {
  fundraising: {
    you: "Their stated investor experience and interest in startups could support your fundraising conversations.",
    them: "Your fundraising goal could be relevant to their stated interest in meeting startups.",
  },
  investing: {
    you: "Their fundraising goal could be relevant to your stated interest in meeting startups.",
    them: "Your stated investor experience and interest in startups could support their fundraising conversations.",
  },
  customers: {
    you: "Their stated interest in evaluating relevant tools could support your search for customers or design partners.",
    them: "Your product work could give them a tool to evaluate for their stated needs.",
  },
  evaluating: {
    you: "Their product work could give you a tool to evaluate for your stated needs.",
    them: "Your stated interest in evaluating relevant tools could support their search for customers or design partners.",
  },
  technical_exchange: {
    you: "Their interest in a technical exchange could help you explore the engineering topics in your goal.",
    them: "Your relevant experience could help them compare approaches and explore technical collaboration.",
  },
  technical_collaboration: {
    you: "Their relevant experience could help you compare approaches and explore technical collaboration.",
    them: "Your interest in a technical exchange could help them explore the engineering topics in their goal.",
  },
};

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
    const roleA = role(positiveText(a.goal.text)),
      roleB = role(positiveText(b.goal.text));
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
    const hiring = a.goal.type === "hiring" ? a.goal : b.goal;
    const seeking = a.goal.type === "seeking_role" ? a.goal : b.goal;
    if (rejects(hiring.text, /\b(?:hire|hiring|recruit|recruiting)\b/i) ||
      rejects(seeking.text, /\b(?:jobs?|roles?|positions?|employment)\b/i)) rolesCompatible = false;
  }
  const collaboration =
    a.goal.type === "collaborators" && b.goal.type === "collaborators";
  const shared = signalsIn(professional(a)).filter((term) =>
    signalsIn(professional(b)).includes(term),
  );
  const forA = signalsIn(positiveText(a.goal.text)).filter((term) =>
    signalsIn(professional(b)).includes(term),
  );
  const forB = signalsIn(positiveText(b.goal.text)).filter((term) =>
    signalsIn(professional(a)).includes(term),
  );
  const contextA = `${professional(a)}. ${positiveText(a.goal.text)}`;
  const contextB = `${professional(b)}. ${positiveText(b.goal.text)}`;
  const sharedFocus = signalsIn(contextA).filter((term) => signalsIn(contextB).includes(term));
  const commercialIntent = [a, b].some((person) => {
    const goal = positiveText(person.goal!.text);
    return seeksInvestment(goal) || seeksCustomers(goal) ||
      (investorProfile(professional(person)) && seeksStartups(goal));
  });
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
  const businessIntent = rolesCompatible ? reciprocalIntent(a, b, sharedFocus) : null;
  const intent = businessIntent ?? (!commercialIntent && rolesCompatible ? technicalExchange(a, b, shared, forA, forB) : null);
  const professionalMatch = !!intent || (
    (complementary || (collaboration && !commercialIntent)) && rolesCompatible &&
    forA.length > 0 &&
    forB.length > 0 &&
    shared.length > 0);
  if (!professionalMatch && !reunion && !registeredTogether) return null;
  const eventSuggestions = (b.events ?? [])
    .filter(
      (event) =>
        inOverlap(event) &&
        !sharedEvents.some((shared) => sameSharedEvent(shared, event)),
    )
    .slice(0, 3);
  const you = intent ? intentBenefits[intent].you : !professionalMatch
    ? connected
      ? "Reconnect at a shared event around your common professional interests."
      : "Meet someone who also reported registering for this event and shares your professional interests."
    : complementary
      ? a.goal.type === "seeking_role"
        ? "Their stated hiring goal aligns with your search for a role."
        : "Their stated role search aligns with your hiring goal."
      : "Their experience supports your stated collaboration goal.";
  const them = intent ? intentBenefits[intent].them : !professionalMatch
    ? connected
      ? "They can continue a conversation with a connection who shares their interests."
      : "They can exchange experience with someone planning the same event who shares their interests."
    : complementary
      ? a.goal.type === "seeking_role"
        ? "Your experience is relevant to their stated hiring needs."
        : "Your hiring goal offers an opportunity they are seeking."
      : "Your experience supports their stated collaboration goal.";
  const evidenceSignals = intent ? sharedFocus : shared;
  return {
    score: Math.min(
      95,
      (professionalMatch && (complementary || businessIntent) ? 65 : 50) +
        Math.min(evidenceSignals.length, 3) * 5 +
        (sharedEvents.length ? 10 : 0),
    ),
    reasons: [
      you,
      intent ? `Shared focus: ${sharedFocus.filter((signal) => focused.has(signal)).join(", ")}.`
        : `Both profiles mention ${shared.join(", ")}.`,
      "Your stays overlap in San Francisco.",
      ...(sharedEvents.length
        ? [sharedEvents[0].attendance === "registered" && b.events?.some((event) =>
            sameSharedEvent(sharedEvents[0], event) && event.attendance === "registered")
          ? `Both reported registering for ${sharedEvents[0].title}.`
          : `Both reported plans to attend ${sharedEvents[0].title}.`]
        : []),
    ],
    benefits: { you, them },
    signals: [...new Set([...evidenceSignals, ...forA, ...forB])],
    overlap: { start, end },
    sharedEvents,
    eventSuggestions,
  };
}
