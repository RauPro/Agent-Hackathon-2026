import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { SF_TIMEZONE, type GoalType, type UserContext } from "./context";

// Fixed stages, not an agent loop. These are product budgets, not provider limits.
export const DISCOVERY_LIMITS = {
  deadlineMs: 55_000,
  leaseMs: 90_000,
  searchTimeoutMs: 12_000,
  candidates: 16,
  enrich: 6,
  extractBatch: 8,
  textWindow: 3_000,
  rank: 10,
  picks: 3,
  perRevision: 5,
  perOwner: 15,
  concurrent: 3,
  exaConcurrent: 6,
  dayMs: 86_400_000,
} as const;
export const PLATFORMS = ["luma", "eventbrite", "partiful", "web"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_NAMES: Record<Platform, string> = {
  luma: "Luma",
  eventbrite: "Eventbrite",
  partiful: "Partiful",
  web: "event page",
};
export const discoveryRequestSchema = z
  .object({
    action: z.enum(["start", "refresh"]),
    revision: z.number().int().positive(),
    requestId: z.uuid(),
  })
  .strict();
export type DiscoveryRequest = z.infer<typeof discoveryRequestSchema>;
export type DiscoveryStatus =
  | "running"
  | "ready"
  | "partial"
  | "empty"
  | "failed";
export class DiscoveryError extends Error {
  readonly kind = "discovery_error";
  constructor(
    public code:
      | "profile_missing"
      | "trip_past"
      | "profile_changed"
      | "busy"
      | "refresh_limit"
      | "daily_limit"
      | "not_configured",
  ) {
    super(code);
  }
}
export function isDiscoveryError(error: unknown): error is DiscoveryError {
  return (
    error instanceof Error &&
    "kind" in error &&
    error.kind === "discovery_error"
  );
}
export type Evidence = { field: string; quote: string; url: string };
export type EventSource = { url: string; platform: Platform };
export type Recommendation = EventSource & {
  id: string;
  title: string;
  alsoListed: EventSource[];
  date: string;
  dateStatus: "confirmed" | "unconfirmed_year";
  startTime: string | null;
  endTime: string | null;
  timeZoneStated: boolean;
  location: {
    venue: string | null;
    address: string | null;
    city: "San Francisco";
    visibility: "public" | "after_registration" | "unknown";
  };
  price: { kind: "free" | "paid" | "varies" | "unknown"; label: string };
  registration: "unknown" | "open" | "approval_required" | "waitlist";
  reason: string;
  caveats: string[];
  evidence: Evidence[];
  checkedAt: string;
};
export type Coverage = {
  sources: {
    platform: Platform;
    status: "ok" | "failed";
    results: number;
    verified: number;
  }[];
  candidates: number;
  verified: number;
  enrichment: "not_needed" | "ok" | "failed";
};
export const emptyCoverage = (): Coverage => ({
  sources: [],
  candidates: 0,
  verified: 0,
  enrichment: "not_needed",
});
export type DiscoveryResult = {
  recommendations: Recommendation[];
  coverage: Coverage;
  checkedAt: string;
};
export type DiscoveryView = {
  configured: boolean;
  profileRevision: number | null;
  stale: boolean;
  draftChanged: boolean;
  outdated: boolean;
  tripPast: boolean;
  dailyLimitReached: boolean;
  window: { start: string; end: string } | null;
  discovery: null | {
    revision: number;
    status: DiscoveryStatus;
    attempts: number;
    canRefresh: boolean;
    startedAt: string;
    finishedAt: string | null;
    checkedAt: string | null;
    errorCode?: string;
    recommendations: Recommendation[];
    coverage: Coverage;
  };
};
export type DiscoveryRow = {
  owner_id: string;
  profile_revision: number;
  status: DiscoveryStatus;
  run_id: string;
  attempts: number;
  request_id: string | null;
  lease_expires_at: number | null;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  result_json: string | null;
};
export type Candidate = EventSource & {
  id: string;
  title: string;
  texts: string[];
};
export type ValidatedCandidate = Recommendation & {
  texts: string[];
  description: string;
  registrationPlatform: Platform | null;
};

const formats = [
  "meetup",
  "demo",
  "hackathon",
  "workshop",
  "dinner",
  "roundtable",
  "conference",
  "pitch",
  "mixer",
] as const;
// Exa can receive only these code-owned labels, formats, static instructions and
// the SF date window. No person, company, product or other profile text can leak
// through model-generated search phrases, even if the planner is compromised.
export const TOPICS = {
  ai_agents: "ai agents",
  llm_infrastructure: "llm infrastructure",
  ai_evaluation: "ai evaluation",
  machine_learning: "machine learning",
  developer_tools: "developer tools",
  data_engineering: "data engineering",
  cloud_infrastructure: "cloud infrastructure",
  cybersecurity: "cybersecurity",
  fintech: "fintech",
  healthtech: "healthtech",
  biotech: "biotech",
  climate_tech: "climate tech",
  robotics: "robotics",
  hardware: "hardware",
  b2b_saas: "b2b saas",
  enterprise_software: "enterprise software",
  go_to_market: "go-to-market and sales",
  product_management: "product management",
  product_design: "product design",
  open_source: "open source",
  consumer_apps: "consumer apps",
  marketplaces: "marketplaces",
  edtech: "edtech",
  web3: "web3",
  typescript: "typescript",
  javascript: "javascript",
  python: "python",
  rust: "rust",
  distributed_systems: "distributed systems",
  databases: "databases",
  observability: "observability",
  mobile_development: "mobile development",
  web_development: "web development",
  accessibility: "accessibility",
  privacy: "privacy",
  compliance: "compliance",
  supply_chain: "supply chain",
  manufacturing: "manufacturing",
  energy: "energy",
  scientific_computing: "scientific computing",
  computer_vision: "computer vision",
  speech_technology: "speech technology",
  startup_operations: "startup operations",
  early_stage_startups: "early-stage startups",
  engineering_management: "engineering management",
  growth: "growth",
  venture_capital: "venture capital",
  creative_tools: "creative tools",
  human_computer_interaction: "human computer interaction",
  research: "research",
  community: "community",
  software_engineering: "software engineering",
} as const;
export const AUDIENCES = {
  startup_founders: "startup founders",
  early_stage_engineers: "early-stage engineers",
  engineering_leaders: "engineering leaders",
  product_managers: "product managers",
  designers: "designers",
  investors: "investors",
  enterprise_buyers: "enterprise buyers",
  domain_practitioners: "domain practitioners",
  operators: "operators",
  researchers: "researchers",
  open_source_maintainers: "open-source maintainers",
  hiring_teams: "hiring teams",
  builders: "hands-on builders",
} as const;
// Model-facing schemas deliberately use no regex/format constraints.
export const planSchema = z.object({
  topics: z.array(
    z.enum(
      Object.keys(TOPICS) as [keyof typeof TOPICS, ...(keyof typeof TOPICS)[]],
    ),
  ),
  audiences: z.array(
    z.enum(
      Object.keys(AUDIENCES) as [
        keyof typeof AUDIENCES,
        ...(keyof typeof AUDIENCES)[],
      ],
    ),
  ),
  formats: z.array(z.enum(formats)),
  avoid: z.array(z.enum(formats)),
});
export type SearchPlan = z.infer<typeof planSchema>;
const defaults: Record<GoalType, SearchPlan> = {
  seeking_role: {
    topics: ["early_stage_startups"],
    audiences: ["early_stage_engineers", "hiring_teams"],
    formats: ["demo", "meetup", "hackathon"],
    avoid: ["pitch"],
  },
  hiring: {
    topics: ["software_engineering"],
    audiences: ["early_stage_engineers", "builders"],
    formats: ["hackathon", "workshop", "meetup"],
    avoid: ["pitch"],
  },
  customers: {
    topics: ["startup_operations"],
    audiences: ["domain_practitioners", "operators", "enterprise_buyers"],
    formats: ["roundtable", "conference"],
    avoid: ["pitch", "mixer"],
  },
  collaborators: {
    topics: ["open_source"],
    audiences: ["builders"],
    formats: ["workshop", "hackathon"],
    avoid: ["pitch"],
  },
};
export function sanitizePlan(
  input: SearchPlan,
  context: UserContext,
): SearchPlan {
  const fallback = defaults[context.goal.type];
  const sanitize = <T extends string>(
    terms: T[],
    vocabulary: Record<T, string>,
    backup: T[],
  ) => {
    const safe = [
      ...new Set(terms.filter((term) => Object.hasOwn(vocabulary, term))),
    ].slice(0, 3);
    return safe.length ? safe : backup;
  };
  const chosen = input.formats.filter((f) => formats.includes(f)).slice(0, 3);
  return {
    topics: sanitize(input.topics, TOPICS, fallback.topics),
    audiences: sanitize(input.audiences, AUDIENCES, fallback.audiences),
    formats:
      context.preferences.meetingFormat === "any"
        ? chosen.length
          ? chosen
          : fallback.formats
        : ["dinner", "roundtable"],
    avoid: [
      ...new Set([
        ...fallback.avoid,
        ...input.avoid.filter((f) => formats.includes(f)),
      ]),
    ].slice(0, 3),
  };
}
export function sfDate(now: Date) {
  return Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO(SF_TIMEZONE)
    .toPlainDate()
    .toString();
}
export function discoveryWindow(context: UserContext, now: Date) {
  const start = [context.trip.start, sfDate(now)].sort().at(-1)!;
  return start > context.trip.end ? null : { start, end: context.trip.end };
}
export function searchQueries(
  plan: SearchPlan,
  window: { start: string; end: string },
) {
  const topics = plan.topics.map((topic) => TOPICS[topic]).filter(Boolean);
  const audiences = plan.audiences
    .map((audience) => AUDIENCES[audience])
    .filter(Boolean);
  const query = `San Francisco ${window.start} to ${window.end} ${topics.join(" ")} ${audiences.join(" ")} ${plan.formats.filter((f) => formats.includes(f)).join(" ")}`;
  const objective = `Find individual event registration pages (not roundups or calendars) for in-person events in San Francisco between ${window.start} and ${window.end}. Rank first events whose attendees include ${audiences.join(", ")}. Exclude online-only events, events outside San Francisco, ${plan.avoid.filter((f) => formats.includes(f)).join(", ") || "listing pages"}. Pull the event date, start time, venue, price, and registration status.`;
  return PLATFORMS.map((platform) => ({
    platform,
    query,
    objective,
    ...(platform === "web"
      ? {
          excludeDomains: [
            "luma.com",
            "lu.ma",
            "eventbrite.com",
            "partiful.com",
          ],
        }
      : {
          includeDomains:
            platform === "luma" ? ["luma.com", "lu.ma"] : [`${platform}.com`],
        }),
  }));
}

export function canonicalUrl(value: string): EventSource | null {
  try {
    const u = new URL(value);
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port)
      return null;
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.hostname === "lu.ma") u.hostname = "luma.com";
    // Sources are public links, never credentials or local resources.
    if (
      !u.hostname.includes(".") ||
      /(^|\.)(localhost|local|internal|test)$/.test(u.hostname) ||
      /^[\d.:\[\]]+$/.test(u.hostname)
    )
      return null;
    u.protocol = "https:";
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname.replace(/\/+$/, "") || "/";
    const platform: Platform =
      u.hostname === "luma.com"
        ? "luma"
        : u.hostname === "eventbrite.com"
          ? "eventbrite"
          : u.hostname === "partiful.com"
            ? "partiful"
            : "web";
    if (platform === "eventbrite") {
      const id = u.pathname.match(/^\/e\/(?:[^/]*-)?(\d+)$/)?.[1];
      if (!id) return null;
      u.pathname = `/e/${id}`;
    }
    if (platform === "partiful" && !/^\/e\/[^/]+$/.test(u.pathname))
      return null;
    return { url: u.toString().replace(/\/$/, ""), platform };
  } catch {
    return null;
  }
}
export function normalizeQuote(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
export function quoteExists(quote: string | null, texts: string[]) {
  const q = normalizeQuote(quote ?? "");
  return (
    q.length > 0 &&
    q.length <= 1000 &&
    texts.some((t) => normalizeQuote(t).includes(q))
  );
}
export const pastMarker =
  /\b(past event|registration closed|sold out|event cancelled|event canceled)\b/i;
export function prefilter(groups: Candidate[][]) {
  const selected: Candidate[] = [],
    byUrl = new Map<string, Candidate>();
  // Round robin prevents one platform from filling the extraction budget.
  for (let rank = 0; rank < 10; rank++)
    for (const group of groups) {
      const raw = group[rank];
      if (!raw) continue;
      const source = canonicalUrl(raw.url);
      if (!source || raw.texts.some((t) => pastMarker.test(t))) continue;
      const existing = byUrl.get(source.url);
      if (existing) {
        existing.texts = [...new Set([...existing.texts, ...raw.texts])];
        continue;
      }
      if (selected.length >= DISCOVERY_LIMITS.candidates) continue;
      const candidate = {
        ...raw,
        ...source,
        id: `event-${selected.length + 1}`,
        texts: [...new Set([raw.title, ...raw.texts])],
      };
      selected.push(candidate);
      byUrl.set(source.url, candidate);
    }
  return selected;
}

const nullableText = z.string().nullable();
export const extractedEventSchema = z.object({
  candidateId: z.string(),
  title: z.string(),
  titleQuote: z.string(),
  descriptionQuote: z.string(),
  month: z.number().nullable(),
  day: z.number().nullable(),
  year: z.number().nullable(),
  weekday: nullableText,
  dateQuote: nullableText,
  yearQuote: nullableText,
  startTime: nullableText,
  endTime: nullableText,
  timeQuote: nullableText,
  timeZone: nullableText,
  venue: nullableText,
  address: nullableText,
  locationQuote: nullableText,
  visibility: z.enum(["public", "after_registration", "unknown"]),
  visibilityQuote: nullableText,
  priceKind: z.enum(["free", "paid", "varies", "unknown"]),
  priceAmount: z.number().nullable(),
  priceQuote: nullableText,
  registration: z.enum([
    "open",
    "unknown",
    "closed",
    "sold_out",
    "past",
    "approval_required",
    "waitlist",
  ]),
  registrationQuote: nullableText,
  attendance: z.enum(["in_person", "online", "hybrid", "unknown"]),
  attendanceQuote: nullableText,
  pageKind: z.enum(["event", "series", "listing"]),
  explicitSession: z.boolean(),
  registrationPlatform: z.enum(PLATFORMS).nullable(),
  registrationLinkQuote: nullableText,
  ambiguities: z.array(
    z.enum(["date", "time", "timezone", "price", "location", "series"]),
  ),
});
export const extractionSchema = z.object({
  events: z.array(extractedEventSchema),
});
export type ExtractedEvent = z.infer<typeof extractedEventSchema>;
export const rankSchema = z.object({
  picks: z.array(
    z.object({
      candidateId: z.string(),
      reason: z.string(),
      evidenceQuote: z.string(),
      caveat: nullableText,
    }),
  ),
});
export type RankedPicks = z.infer<typeof rankSchema>;
const months = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];
const weekdayIndex = (s: string) =>
  weekdays.findIndex((day) =>
    day.startsWith(s.toLowerCase().replace(/\.$/, "")),
  );
const hasDigits = (s: string, n: number) =>
  new RegExp(`(^|\\D)0?${String(n).replace(".", "\\.")}(?!\\d)`).test(s);

export function verifiedDate(
  f: ExtractedEvent,
  candidate: Candidate,
  context: UserContext,
  now: Date,
) {
  if (
    !quoteExists(f.dateQuote, candidate.texts) ||
    f.ambiguities.includes("date")
  )
    return null;
  if (
    !Number.isInteger(f.month) ||
    !Number.isInteger(f.day) ||
    f.month! < 1 ||
    f.month! > 12
  )
    return null;
  const quote = normalizeQuote(f.dateQuote!);
  const month = months[f.month! - 1];
  const namedMonth = months.some((m) =>
    new RegExp(`\\b${m.slice(0, 3)}(?:${m.slice(3)})?\\b`).test(quote),
  );
  if (
    !(
      new RegExp(`\\b${month.slice(0, 3)}(?:${month.slice(3)})?\\b`).test(
        quote,
      ) ||
      (!namedMonth && hasDigits(quote, f.month!))
    ) ||
    !hasDigits(quote, f.day!)
  )
    return null;
  const stated = [
    ...quote.matchAll(
      /\b(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b/g,
    ),
  ].map((m) => weekdayIndex(m[1]));
  if (f.weekday) {
    const index = weekdayIndex(f.weekday);
    if (index < 0 || !stated.includes(index)) return null;
  }
  const window = discoveryWindow(context, now);
  if (!window) return null;
  const yearQuote = quoteExists(f.yearQuote, candidate.texts)
    ? f.yearQuote!
    : "";
  const explicitYear =
    f.year !== null &&
    Number.isInteger(f.year) &&
    f.year >= 1900 &&
    f.year <= 2100 &&
    new RegExp(`\\b${f.year}\\b`).test(`${quote} ${yearQuote}`);
  // A model cannot declare a year that isn't in an event-specific quote.
  if (f.year !== null && !explicitYear) return null;
  if (!explicitYear && (!stated.length || /\b(?:19|20)\d{2}\b/.test(quote)))
    return null;
  const currentYear = Temporal.PlainDate.from(sfDate(now)).year;
  const years = explicitYear ? [f.year!] : [currentYear, currentYear + 1];
  const dates = years.flatMap((year) => {
    try {
      const date = Temporal.PlainDate.from(
        { year, month: f.month!, day: f.day! },
        { overflow: "reject" },
      );
      const value = date.toString();
      if (
        stated.some((day) => date.dayOfWeek !== day + 1) ||
        value < window.start ||
        value > window.end
      )
        return [];
      return [value];
    } catch {
      return [];
    }
  });
  return dates.length === 1
    ? {
        date: dates[0],
        dateStatus: explicitYear
          ? ("confirmed" as const)
          : ("unconfirmed_year" as const),
      }
    : null;
}

export function validateCandidate(
  candidate: Candidate,
  raw: ExtractedEvent,
  context: UserContext,
  now: Date,
): ValidatedCandidate | null {
  const parsed = extractedEventSchema.safeParse(raw);
  if (!parsed.success || raw.candidateId !== candidate.id) return null;
  const f = parsed.data,
    has = (quote: string | null) => quoteExists(quote, candidate.texts);
  const date = verifiedDate(f, candidate, context, now);
  if (!date || candidate.texts.some((t) => pastMarker.test(t))) return null;
  if (
    context.goal.type === "seeking_role" &&
    /\bemployer[ -](?:only|ticket)\b/i.test(candidate.title)
  )
    return null;
  if (
    (f.pageKind !== "event" || f.ambiguities.includes("series")) &&
    !f.explicitSession
  )
    return null;
  if (
    f.attendance === "online" ||
    f.ambiguities.includes("location") ||
    !has(f.locationQuote)
  )
    return null;
  const location = f.locationQuote!;
  if (
    /\b(palo alto|oakland|mountain view|san jose|berkeley|silicon valley)\b/i.test(
      location,
    ) ||
    !/\b(san francisco|sf|941\d{2})\b/i.test(location)
  )
    return null;
  if (["closed", "sold_out", "past"].includes(f.registration)) return null;
  if (
    !has(f.titleQuote) ||
    !quoteExists(f.title, [f.titleQuote]) ||
    f.title.length > 240 ||
    !has(f.descriptionQuote)
  )
    return null;
  const evidence: Evidence[] = [];
  const add = (field: string, quote: string | null) => {
    if (has(quote)) evidence.push({ field, quote: quote!, url: candidate.url });
  };
  add("title", f.titleQuote);
  add("date", f.dateQuote);
  add("year", f.yearQuote);
  add("location", location);
  add("description", f.descriptionQuote);
  const caveats: string[] = [];
  if (date.dateStatus === "unconfirmed_year")
    caveats.push("The event page doesn't state the year.");
  const validTime = (time: string | null) =>
    !!time &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(time) &&
    has(f.timeQuote) &&
    (hasDigits(f.timeQuote!, Number(time.slice(0, 2))) ||
      hasDigits(f.timeQuote!, Number(time.slice(0, 2)) % 12 || 12));
  let startTime = validTime(f.startTime) ? f.startTime : null;
  let endTime = validTime(f.endTime) ? f.endTime : null;
  let timeZoneStated = false;
  let conflict =
    f.ambiguities.includes("time") || f.ambiguities.includes("timezone");
  const zone = normalizeQuote(f.timeZone ?? "").replace(/[−–]/g, "-");
  const zoneWords =
    (f.timeQuote ?? "")
      .replace(/(?:UTC[−–-]0[78]:00|GMT[−–-][78])/gi, "PT")
      .match(/\b[A-Z]{2,5}\b/g) ?? [];
  if (
    zoneWords.some((label) => !["AM", "PM", "PT", "PST", "PDT"].includes(label))
  )
    conflict = true;
  if (!zone && zoneWords.some((label) => ["PT", "PST", "PDT"].includes(label)))
    conflict = true;
  if (zone && startTime) {
    const timeQuote = normalizeQuote(f.timeQuote ?? "").replace(/[−–]/g, "-");
    if (
      !timeQuote.includes(zone) ||
      !/^(pt|pst|pdt|pacific|pacific time|utc-0[78]:00|gmt-[78])$/.test(zone)
    )
      conflict = true;
    else {
      try {
        const instant = Temporal.ZonedDateTime.from(
          `${date.date}T${startTime}[${SF_TIMEZONE}]`,
          { disambiguation: "reject" },
        );
        const rawZones = normalizeQuote(f.timeQuote ?? "").replace(
          /[−–]/g,
          "-",
        );
        if (
          (/\bpst\b|utc-08:00|gmt-8\b/.test(rawZones) &&
            instant.offset !== "-08:00") ||
          (/\bpdt\b|utc-07:00|gmt-7\b/.test(rawZones) &&
            instant.offset !== "-07:00")
        )
          conflict = true;
        const offset =
          zone === "pst" || /(?:08:00|gmt-8)$/.test(zone)
            ? "-08:00"
            : zone === "pdt" || /(?:07:00|gmt-7)$/.test(zone)
              ? "-07:00"
              : null;
        if (offset && offset !== instant.offset) conflict = true;
        else timeZoneStated = true;
      } catch {
        conflict = true;
      }
    }
  }
  for (const time of [startTime, endTime])
    if (time) {
      try {
        Temporal.ZonedDateTime.from(`${date.date}T${time}[${SF_TIMEZONE}]`, {
          disambiguation: "reject",
        });
      } catch {
        conflict = true;
      }
    }
  // Overnight or multiple-day timing needs a richer contract; keep only the date.
  if (startTime && endTime && endTime <= startTime) conflict = true;
  if (conflict) {
    startTime = null;
    endTime = null;
    timeZoneStated = false;
    caveats.push(
      "The listed time or time zone conflicts; check the event page.",
    );
  } else if (startTime) {
    add("time", f.timeQuote);
    if (!timeZoneStated)
      caveats.push("Time zone not stated; confirm the listed time.");
    if (!endTime) caveats.push("End time not listed.");
  } else {
    endTime = null;
    caveats.push("Start time not confirmed.");
  }
  let price: Recommendation["price"] = {
    kind: "unknown",
    label: "Price not listed",
  };
  let amount: number | null = null;
  if (
    has(f.priceQuote) &&
    !/\b(sponsor(?:ship)?|donation|prize)\b/i.test(f.priceQuote!)
  ) {
    const quote = f.priceQuote!;
    const prices = new Set(quote.match(/\$\s*\d[\d,]*(?:\.\d{2})?/g) ?? []);
    if (
      f.priceKind === "varies" ||
      f.ambiguities.includes("price") ||
      prices.size > 1 ||
      (/\bfree\b/i.test(quote) &&
        [...prices].some((s) => !/^\$\s*0(?:\.00)?$/.test(s)))
    )
      price = { kind: "varies", label: "Price varies" };
    else if (
      f.priceKind === "free" &&
      /\bfree\b|\$\s*0(?:\.00)?(?![\d.])/i.test(quote)
    ) {
      price = { kind: "free", label: "Free" };
      amount = 0;
    } else if (
      f.priceKind === "paid" &&
      f.priceAmount !== null &&
      Number.isFinite(f.priceAmount) &&
      f.priceAmount > 0 &&
      hasDigits(quote.replace(/,/g, ""), f.priceAmount)
    ) {
      amount = f.priceAmount;
      price = {
        kind: "paid",
        label: new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          maximumFractionDigits: 2,
        }).format(amount),
      };
    }
    if (price.kind !== "unknown") add("price", quote);
  }
  const budget = context.preferences.budgetUsd;
  if (budget !== null) {
    if (amount !== null && amount > budget) return null;
    if (amount === null) caveats.push("Can't confirm it fits your budget.");
  }
  if (context.commitments.status === "provided") {
    if (
      startTime &&
      endTime &&
      timeZoneStated &&
      date.dateStatus === "confirmed"
    ) {
      if (
        context.commitments.items.some(
          (c) =>
            c.date === date.date && startTime! < c.end && endTime! > c.start,
        )
      )
        return null;
    } else
      caveats.push("Couldn't check overlap with your reported commitments.");
  }
  const visibility = has(f.visibilityQuote) ? f.visibility : "unknown";
  if (visibility === "after_registration") {
    caveats.push("Address available after registration.");
    add("visibility", f.visibilityQuote);
  }
  const registration = has(f.registrationQuote)
    ? (f.registration as Recommendation["registration"])
    : "unknown";
  if (registration === "approval_required")
    caveats.push("Registration approval required.");
  if (registration === "waitlist") caveats.push("Waitlist only.");
  add("registration", f.registrationQuote);
  const registrationPlatform =
    has(f.registrationLinkQuote) &&
    f.registrationPlatform &&
    new RegExp(
      f.registrationPlatform === "luma"
        ? "luma|lu\\.ma"
        : f.registrationPlatform,
      "i",
    ).test(f.registrationLinkQuote!)
      ? f.registrationPlatform
      : null;
  add("registration link", f.registrationLinkQuote);
  return {
    id: candidate.id,
    title: f.title,
    url: candidate.url,
    platform: candidate.platform,
    alsoListed: [],
    ...date,
    startTime,
    endTime,
    timeZoneStated,
    location: {
      venue: f.venue && quoteExists(f.venue, [location]) ? f.venue : null,
      address:
        visibility !== "after_registration" &&
        f.address &&
        quoteExists(f.address, [location])
          ? f.address
          : null,
      city: "San Francisco",
      visibility,
    },
    price,
    registration,
    reason: "",
    caveats,
    evidence,
    checkedAt: now.toISOString(),
    texts: candidate.texts,
    description: f.descriptionQuote,
    registrationPlatform,
  };
}

function titleTokens(title: string) {
  return normalizeQuote(title)
    .replace(/(?:\||·)\s*(?:luma|eventbrite|partiful).*$/, "")
    .replace(/\btickets?\b/g, "")
    .replace(/[^a-z0-9#]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(
      (s) =>
        ![
          "the",
          "a",
          "an",
          "and",
          "in",
          "at",
          "for",
          "of",
          "on",
          "by",
        ].includes(s),
    );
}
export function titlesMatch(a: string, b: string) {
  const x = titleTokens(a),
    y = titleTokens(b);
  if (
    x.filter((s) => /\d/.test(s)).join(" ") !==
    y.filter((s) => /\d/.test(s)).join(" ")
  )
    return false;
  if (x.join(" ") === y.join(" ")) return x.length > 0;
  const union = new Set([...x, ...y]);
  return (
    Math.min(x.length, y.length) >= 3 &&
    [...new Set(x)].filter((s) => y.includes(s)).length / union.size >= 0.85
  );
}
export function sameEvent(a: ValidatedCandidate, b: ValidatedCandidate) {
  if (canonicalUrl(a.url)?.url === canonicalUrl(b.url)?.url) return true;
  return (
    a.platform !== b.platform &&
    a.date === b.date &&
    !!a.startTime &&
    a.startTime === b.startTime &&
    a.timeZoneStated === b.timeZoneStated &&
    titlesMatch(a.title, b.title)
  );
}
export function deduplicate(candidates: ValidatedCandidate[]) {
  const result: ValidatedCandidate[] = [];
  for (const candidate of candidates) {
    const existing = result.find((r) => sameEvent(r, candidate));
    if (!existing) {
      result.push({ ...candidate });
      continue;
    }
    const sources = [
      ...new Map(
        [
          existing,
          ...existing.alsoListed,
          candidate,
          ...candidate.alsoListed,
        ].map(({ url, platform }) => [url, { url, platform }]),
      ).values(),
    ];
    const requested =
      existing.registrationPlatform ?? candidate.registrationPlatform;
    sources.sort(
      (a, b) =>
        (a.platform === requested ? -1 : PLATFORMS.indexOf(a.platform)) -
        (b.platform === requested ? -1 : PLATFORMS.indexOf(b.platform)),
    );
    existing.url = sources[0].url;
    existing.platform = sources[0].platform;
    existing.alsoListed = sources.slice(1);
    existing.texts = [...new Set([...existing.texts, ...candidate.texts])];
    existing.description += `\n${candidate.description}`;
    existing.evidence = [...existing.evidence, ...candidate.evidence];
    existing.caveats = [
      ...new Set([...existing.caveats, ...candidate.caveats]),
    ];
    if (candidate.dateStatus === "confirmed") existing.dateStatus = "confirmed";
    if (existing.dateStatus === "confirmed")
      existing.caveats = existing.caveats.filter(
        (c) => c !== "The event page doesn't state the year.",
      );
    if (existing.price.label !== candidate.price.label) {
      existing.price = { kind: "varies", label: "Price varies" };
      existing.caveats.push(
        "Prices differ across sources; check the registration page.",
      );
    }
    if (
      candidate.registration === "approval_required" ||
      candidate.registration === "waitlist"
    )
      existing.registration = candidate.registration;
  }
  return result;
}
export function validateRanking(
  input: RankedPicks,
  candidates: ValidatedCandidate[],
): Recommendation[] {
  const parsed = rankSchema.parse(input);
  if (parsed.picks.length > DISCOVERY_LIMITS.picks)
    throw new Error("invalid_ranking");
  const ids = new Set<string>();
  return parsed.picks.map((pick) => {
    const c = candidates.find((candidate) => candidate.id === pick.candidateId);
    if (
      !c ||
      ids.has(c.id) ||
      !pick.reason.trim() ||
      pick.reason.length > 240 ||
      !quoteExists(pick.evidenceQuote, [c.description]) ||
      !quoteExists(pick.evidenceQuote, c.texts) ||
      (pick.caveat && pick.caveat.length > 240)
    )
      throw new Error("invalid_ranking");
    ids.add(c.id);
    // Only the public contract is persisted; retrieved page text stays in this run.
    const {
      texts: _texts,
      description: _description,
      registrationPlatform: _platform,
      ...recommendation
    } = c;
    void _texts;
    void _description;
    void _platform;
    return {
      ...recommendation,
      reason: pick.reason.trim(),
      caveats: [
        ...new Set([...c.caveats, ...(pick.caveat ? [pick.caveat] : [])]),
      ],
      evidence: [
        ...c.evidence,
        {
          field: "goal fit",
          quote: pick.evidenceQuote,
          url:
            c.evidence.find(
              (e) =>
                e.field === "description" &&
                quoteExists(pick.evidenceQuote, [e.quote]),
            )?.url ?? c.url,
        },
      ],
    };
  });
}
export function eventHasEnded(event: Recommendation, now: Date) {
  if (event.date < sfDate(now)) return true;
  if (
    event.dateStatus !== "confirmed" ||
    !event.endTime ||
    !event.timeZoneStated
  )
    return false;
  try {
    return (
      Temporal.ZonedDateTime.from(
        `${event.date}T${event.endTime}[${SF_TIMEZONE}]`,
        { disambiguation: "reject" },
      ).epochMilliseconds <= now.getTime()
    );
  } catch {
    return false;
  }
}
