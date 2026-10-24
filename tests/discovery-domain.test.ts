import { describe, expect, it } from "vitest";
import {
  canonicalUrl,
  deduplicate,
  discoveryWindow,
  eventHasEnded,
  prefilter,
  quoteExists,
  sameEvent,
  sanitizePlan,
  searchQueries,
  validateCandidate,
  validateRanking,
  type ExtractedEvent,
  type SearchPlan,
} from "../src/lib/domain/event-discovery";
import { discoveryNow, eventFixture } from "./discovery-fixtures";
import { validContext } from "./fixtures";

function validated(
  overrides: Partial<ExtractedEvent> = {},
  extra = "",
  context = validContext(),
) {
  const f = eventFixture(overrides, extra);
  return validateCandidate(f.candidate, f.extracted, context, discoveryNow());
}
describe("private profile to bounded search terms", () => {
  it("rejects names, email, URLs and non-year digits; uses goal defaults", () => {
    const plan = sanitizePlan(
      {
        topics: [
          "Alex",
          "Rivera",
          "alex@example.com",
          "http://foo.com",
          "www.foo.com",
          "123 secrets",
        ],
        audiences: [],
        formats: [],
        avoid: [],
      } as unknown as SearchPlan,
      validContext(),
    );
    expect(plan.topics).toEqual(["early_stage_startups"]);
    expect(JSON.stringify(plan)).not.toMatch(
      /alex|rivera|example|http|www|123/,
    );
    expect(
      sanitizePlan(
        { ...plan, topics: ["ai_agents", "ai_evaluation"] },
        validContext(),
      ).topics,
    ).toEqual(["ai_agents", "ai_evaluation"]);
  });
  it("assembles separate platform searches with distinct goal defaults and an SF date window", () => {
    const context = validContext();
    const window = discoveryWindow(context, new Date("2026-10-25T02:00:00Z"))!;
    expect(window).toEqual({ start: "2026-10-24", end: "2026-11-05" });
    const empty = { topics: [], audiences: [], formats: [], avoid: [] };
    const role = searchQueries(sanitizePlan(empty, context), window);
    context.goal.type = "customers";
    const customer = searchQueries(sanitizePlan(empty, context), window);
    expect(customer[0].query).not.toBe(role[0].query);
    expect(customer[0].objective).toContain(
      "domain practitioners, operators, enterprise buyers",
    );
    expect(role).toHaveLength(4);
    expect(role[0]).toMatchObject({ includeDomains: ["luma.com", "lu.ma"] });
    expect(role[3]).toMatchObject({
      excludeDomains: ["luma.com", "lu.ma", "eventbrite.com", "partiful.com"],
    });
    expect(
      discoveryWindow(context, new Date("2026-11-06T18:00:00Z")),
    ).toBeNull();
    context.preferences.meetingFormat = "one_to_one";
    expect(sanitizePlan(empty, context).formats).toEqual([
      "dinner",
      "roundtable",
    ]);
  });
});
describe("narrow evidence and constraint checks", () => {
  it("defers street addresses to the official page even when cached text is classified as public", () => {
    const result = validated();
    expect(result?.location.address).toBeNull();
    expect(result?.location.venue).toBe("Demo Hall");
    expect(JSON.stringify(result?.evidence)).not.toContain(
      "123 Example Street",
    );
    expect(result?.caveats).toContain(
      "Check the official event page for the current address.",
    );
  });
  it.each([
    { visibility: "unknown" as const, visibilityQuote: null },
    { visibility: "after_registration" as const },
  ])(
    "withholds unconfirmed or gated venue details, including source quotes: %j",
    (changes) => {
      const result = validated(changes);
      expect(result).not.toBeNull();
      expect(result?.location.address).toBeNull();
      expect(result?.location.venue).toBeNull();
      expect(result?.evidence.find((e) => e.field === "location")?.quote).toBe(
        "San Francisco",
      );
      expect(JSON.stringify(result?.evidence)).not.toContain(
        "123 Example Street",
      );
    },
  );
  it("withholds a cached address when the page explicitly gates it, despite a public model classification", () => {
    const result = validated({}, "Register to See Address");
    expect(result?.location).toMatchObject({
      visibility: "after_registration",
      venue: null,
      address: null,
    });
    expect(result?.caveats).toContain("Address available after registration.");
  });
  it.each([
    { startTime: "17:45", timeQuote: "5:00 PM – 9:00 PM (UTC-08:00)" },
    { startTime: "17:00", timeQuote: "5:00 AM – 9:00 PM (UTC-08:00)" },
    {
      startTime: "17:00",
      timeQuote: "Doors open at 6 PM, 5 speakers (UTC-08:00)",
    },
  ])("does not present an unsupported exact time: %j", (changes) => {
    expect(validated(changes)?.startTime).toBeNull();
  });
  it.each([
    { startTime: "17:45", timeQuote: "5:45 PM – 9:00 PM (UTC-08:00)" },
    { startTime: "17:45", timeQuote: "17:45 – 21:00 (UTC-08:00)" },
  ])("preserves a supported exact time: %j", (changes) => {
    expect(validated(changes)?.startTime).toBe("17:45");
  });
  it("accepts the normalized Luma-style header with explicit year and Pacific offset", () => {
    expect(validated()).toMatchObject({
      date: "2026-11-05",
      dateStatus: "confirmed",
      startTime: "17:00",
      endTime: "21:00",
      timeZoneStated: true,
      price: { kind: "free" },
    });
  });
  it("normalizes NFKC, zero-width characters, case and whitespace only for quote existence", () => {
    expect(quoteExists("FREE tickets", ["ＦＲＥＥ\u200b  \n Tickets"])).toBe(
      true,
    );
    expect(quoteExists("", ["x"])).toBe(false);
  });
  it.each([
    { dateQuote: "November 5, 2026 (Tuesday)", weekday: "Tuesday" },
    { dateQuote: "Nov 5", year: null, weekday: null },
    {
      dateQuote: "Tuesday, Mar 10",
      year: null,
      month: 3,
      day: 10,
      weekday: "Tuesday",
    },
    { dateQuote: "Thursday, Nov 5", year: 2026 },
    { dateQuote: "Thursday, Nov 4, 2026", day: 5 },
    { dateQuote: "Thursday, Nov 5, 2026", ambiguities: ["date"] },
  ] satisfies Partial<ExtractedEvent>[])(
    "rejects unsupported, contradictory or past dates: %j",
    (patch) => {
      expect(validated(patch)).toBeNull();
    },
  );
  it("labels a uniquely fitting weekday/date without claiming the year is stated", () => {
    expect(
      validated({ year: null, dateQuote: "Thursday, Nov 5" }),
    ).toMatchObject({
      dateStatus: "unconfirmed_year",
      caveats: expect.arrayContaining([
        "The event page doesn't state the year.",
      ]),
    });
  });
  it("uses an explicit event year in the title", () => {
    expect(
      validated({
        dateQuote: "Thursday, Nov 5",
        yearQuote: "TypeScript Builder Night: NOVEMBER 2026",
      })?.dateStatus,
    ).toBe("confirmed");
  });
  it.each([
    { timeZone: "PKT", timeQuote: "5:00pm – 9:00pm PKT ET" },
    { timeZone: "UTC-07:00", timeQuote: "5:00 PM – 9:00 PM (UTC-07:00)" },
    {
      timeZone: "PT",
      timeQuote: "5:00 PM – 9:00 PM PT ET",
      ambiguities: ["timezone"],
    },
    { timeZone: "PT", timeQuote: "5:00 PM – 9:00 PM PT ET", ambiguities: [] },
    { timeZone: null, timeQuote: "5:00 PM – 9:00 PM PKT", ambiguities: [] },
  ] satisfies Partial<ExtractedEvent>[])(
    "keeps the date but drops conflicting time: %j",
    (patch) => {
      expect(validated(patch)).toMatchObject({
        date: "2026-11-05",
        startTime: null,
        endTime: null,
        caveats: expect.arrayContaining([
          "The listed time or time zone conflicts; check the event page.",
        ]),
      });
    },
  );
  it("labels listed time with no zone, and rejects a DST-ambiguous time", () => {
    expect(
      validated({ timeZone: null, timeQuote: "5 PM - 9 PM" })?.caveats,
    ).toContain("Time zone not stated; confirm the listed time.");
    expect(
      validated({
        dateQuote: "Sunday, November 1, 2026",
        weekday: "Sunday",
        day: 1,
        startTime: "01:30",
        endTime: "02:30",
        timeZone: "PT",
        timeQuote: "1:30 AM – 2:30 AM PT",
      })?.startTime,
    ).toBeNull();
  });
  it("does not invent fields when quotes are missing or from another candidate", () => {
    const f = eventFixture();
    f.extracted.priceQuote = "Tickets $99";
    f.extracted.priceKind = "paid";
    f.extracted.priceAmount = 99;
    f.extracted.timeQuote = "6 PM - 10 PM";
    const result = validateCandidate(
      f.candidate,
      f.extracted,
      validContext(),
      discoveryNow(),
    );
    expect(result?.price.kind).toBe("unknown");
    expect(result?.startTime).toBeNull();
    f.extracted.locationQuote = "Another San Francisco venue";
    expect(
      validateCandidate(
        f.candidate,
        f.extracted,
        validContext(),
        discoveryNow(),
      ),
    ).toBeNull();
  });
  it.each(["Past Event", "Registration Closed", "Sold Out"])(
    "excludes explicit %s",
    (text) => {
      expect(validated({}, text)).toBeNull();
    },
  );
  it.each([
    "Palo Alto",
    "Silicon Valley",
    "Oakland",
    "Mountain View",
    "San Jose",
    "Berkeley",
    "Location pending",
  ])("does not treat %s as SF", (location) => {
    expect(validated({ locationQuote: location })).toBeNull();
  });
  it("rejects series, listing pages, and online-only events", () => {
    expect(
      validated(
        { pageKind: "series", explicitSession: false },
        "Multiple dates",
      ),
    ).toBeNull();
    expect(
      validated({ pageKind: "listing", explicitSession: false }),
    ).toBeNull();
    expect(validated({ attendance: "online" })).toBeNull();
    expect(
      validated({ pageKind: "series", explicitSession: true }),
    ).not.toBeNull();
  });
  it("keeps unknown prices distinct from free and rejects sponsorship as a ticket price", () => {
    expect(
      validated({ priceKind: "unknown", priceQuote: null })?.price.kind,
    ).toBe("unknown");
    expect(
      validated({
        priceKind: "paid",
        priceAmount: 10000,
        priceQuote: "Sponsorship $10,000",
      })?.price.kind,
    ).toBe("unknown");
    expect(
      validated({ priceKind: "free", priceQuote: "Tickets $99 or Free" })?.price
        .kind,
    ).toBe("varies");
  });
  it("enforces a known price budget and caveats unknown/varied prices", () => {
    const c = validContext();
    c.preferences.budgetUsd = 20;
    expect(
      validated(
        { priceKind: "paid", priceAmount: 99, priceQuote: "Tickets $99" },
        "",
        c,
      ),
    ).toBeNull();
    expect(
      validated({ priceKind: "unknown", priceQuote: null }, "", c)?.caveats,
    ).toContain("Can't confirm it fits your budget.");
    expect(validated({}, "", c)?.price.kind).toBe("free");
  });
  it("rejects verified commitment overlaps and caveats uncertain timing", () => {
    const c = validContext();
    c.commitments = {
      status: "provided",
      items: [
        { title: "Dinner", date: "2026-11-05", start: "18:00", end: "19:00" },
      ],
    };
    expect(validated({}, "", c)).toBeNull();
    expect(
      validated({ timeZone: null, timeQuote: "5 PM - 9 PM" }, "", c)?.caveats,
    ).toContain("Couldn't check overlap with your reported commitments.");
  });
  it("surfaces approval, waitlist, hidden addresses and filters ended events", () => {
    const event = validated({
      registration: "approval_required",
      registrationQuote: "Registration Approval Required",
      visibility: "after_registration",
      visibilityQuote: "Sign in for full location",
    })!;
    expect(event.caveats).toContain("Registration approval required.");
    expect(event.caveats).toContain("Address available after registration.");
    expect(event.location.address).toBeNull();
    expect(eventHasEnded(event, new Date("2026-11-06T06:00:00Z"))).toBe(true);
    expect(
      validated({
        registration: "waitlist",
        registrationQuote: "Join waitlist",
      })?.caveats,
    ).toContain("Waitlist only.");
  });
});
describe("event identity and ranking", () => {
  it.each([
    ["https://www.lu.ma/abc/?utm_source=x#hi", "https://luma.com/abc"],
    [
      "https://www.eventbrite.com/e/old-slug-123456?x=1",
      "https://eventbrite.com/e/123456",
    ],
    [
      "https://eventbrite.com/e/new-slug-123456",
      "https://eventbrite.com/e/123456",
    ],
    ["https://partiful.com/e/AbCd/", "https://partiful.com/e/AbCd"],
  ])("canonicalizes %s", (input, expected) =>
    expect(canonicalUrl(input)?.url).toBe(expected),
  );
  it.each([
    "javascript:alert(1)",
    "http://127.0.0.1/x",
    "https://eventbrite.com/d/ca-san-francisco",
    "https://partiful.com/discover",
    "https://user:pass@luma.com/event",
  ])("rejects non-event/unsafe URL %s", (url) =>
    expect(canonicalUrl(url)).toBeNull(),
  );
  it("merges matching cross-posts, keeps sources and follows the registration instruction", () => {
    const a = validated({
      title: "Tech & AI Social Tickets | Eventbrite",
      titleQuote: "Tech & AI Social Tickets | Eventbrite",
    })!;
    a.url = "https://eventbrite.com/e/social-12345";
    a.platform = "eventbrite";
    const b = validated({
      candidateId: "event-2",
      title: "Tech & AI Social | Partiful",
      titleQuote: "Tech & AI Social | Partiful",
      registrationPlatform: "eventbrite",
      registrationLinkQuote: "RSVP on Eventbrite",
      year: null,
      dateQuote: "Thursday, Nov 5",
    })!;
    b.url = "https://partiful.com/e/Social";
    b.platform = "partiful";
    const merged = deduplicate([b, a]);
    expect(merged).toHaveLength(1);
    expect(merged[0].platform).toBe("eventbrite");
    expect(merged[0].alsoListed).toEqual([
      { url: b.url, platform: "partiful" },
    ]);
    expect(merged[0].dateStatus).toBe("confirmed");
    expect(merged[0].caveats).not.toContain(
      "The event page doesn't state the year.",
    );
  });
  it("never merges two different events just because venue and time coincide", () => {
    const a = validated()!,
      b = validated({
        title: "Investor Pitch Night",
        titleQuote: "Investor Pitch Night",
        candidateId: "event-2",
      })!;
    b.platform = "partiful";
    b.url = "https://partiful.com/e/different";
    expect(sameEvent(a, b)).toBe(false);
    expect(deduplicate([a, b])).toHaveLength(2);
  });
  it("preserves editions and dates", () => {
    const a = validated({
      title: "Builder Night #3",
      titleQuote: "Builder Night #3",
    })!;
    const b = {
      ...a,
      title: "Builder Night #4",
      platform: "partiful" as const,
      url: "https://partiful.com/e/next",
    };
    expect(sameEvent(a, b)).toBe(false);
    expect(sameEvent(a, { ...b, title: a.title, date: "2026-11-04" })).toBe(
      false,
    );
  });
  it("round-robins platforms, canonical-dedupes and drops past markers", () => {
    const c = eventFixture().candidate;
    const a = prefilter([
      [c, { ...c, url: "https://lu.ma/builder-night?x=1" }],
      [
        { ...c, url: "https://partiful.com/e/one" },
        { ...c, url: "https://partiful.com/e/past", texts: ["Past Event"] },
      ],
    ]);
    expect(a).toHaveLength(2);
  });
  it("accepts zero picks without padding; rejects unknown, duplicate, excessive or ungrounded picks", () => {
    const c = validated()!;
    const p = {
      candidateId: c.id,
      reason: "The hands-on format could help you meet technical teams.",
      evidenceQuote: c.description,
      caveat: null,
    };
    expect(validateRanking({ picks: [] }, [c])).toEqual([]);
    expect(validateRanking({ picks: [p] }, [c])).toHaveLength(1);
    for (const picks of [
      [{ ...p, candidateId: "forged" }],
      [p, p],
      [p, p, p, p],
      [{ ...p, evidenceQuote: "Made up description" }],
    ])
      expect(() => validateRanking({ picks }, [c])).toThrow();
  });
});
