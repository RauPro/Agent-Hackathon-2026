import type { Candidate, ExtractedEvent } from "../src/lib/domain/event-discovery";

export const discoveryNow = () => new Date("2026-10-24T18:00:00Z");
// Synthetic evidence inspired by observed platform formats, never live data.
export function eventFixture(
  overrides: Partial<ExtractedEvent> = {},
  extraText = "",
) {
  const extracted: ExtractedEvent = {
    candidateId: "event-1",
    title: "TypeScript Builder Night",
    titleQuote: "TypeScript Builder Night",
    descriptionQuote: "Build TypeScript agents with small engineering teams.",
    month: 11,
    day: 5,
    year: 2026,
    weekday: "Thursday",
    dateQuote: "Thursday, Nov 5, 2026",
    yearQuote: null,
    startTime: "17:00",
    endTime: "21:00",
    timeQuote: "5:00 PM – 9:00 PM (UTC-08:00)",
    timeZone: "UTC-08:00",
    venue: "Demo Hall",
    address: "123 Example Street",
    locationQuote:
      "Demo Hall, 123 Example Street, San Francisco, California, US",
    visibility: "public",
    visibilityQuote:
      "Location: Demo Hall, 123 Example Street, San Francisco, California, US",
    priceKind: "free",
    priceAmount: 0,
    priceQuote: "Admission: Free",
    registration: "open",
    registrationQuote: "Register",
    attendance: "in_person",
    attendanceQuote: "Attendance: In person",
    pageKind: "event",
    explicitSession: true,
    registrationPlatform: null,
    registrationLinkQuote: null,
    ambiguities: [],
    ...overrides,
  };
  const text = [
    extracted.titleQuote,
    extracted.descriptionQuote,
    extracted.dateQuote,
    extracted.yearQuote,
    extracted.timeQuote,
    extracted.locationQuote,
    extracted.visibilityQuote,
    extracted.priceQuote,
    extracted.registrationQuote,
    extracted.attendanceQuote,
    extracted.registrationLinkQuote,
    extraText,
  ]
    .filter(Boolean)
    .join("\n");
  const candidate: Candidate = {
    id: extracted.candidateId,
    title: extracted.title,
    url: "https://luma.com/builder-night",
    platform: "luma",
    texts: [text],
  };
  return { candidate, extracted };
}
