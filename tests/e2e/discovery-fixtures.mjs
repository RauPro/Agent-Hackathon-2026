import { Temporal } from "@js-temporal/polyfill";

export function discoveryDates() {
  const today = Temporal.Now.zonedDateTimeISO(
    "America/Los_Angeles",
  ).toPlainDate();
  return {
    start: today.toString(),
    end: today.add({ days: 14 }).toString(),
    date: today.add({ days: 2 }),
  };
}
export function fixtureEvent(kind = "demo", past = false) {
  const date = past
    ? discoveryDates().date.subtract({ days: 10 })
    : discoveryDates().date;
  const dayName = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ][date.dayOfWeek - 1];
  const dateQuote = `${dayName}, ${date.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
  const lab = kind === "lab";
  const title = lab ? "TypeScript Builders Lab" : "Early Team Demos";
  const event = {
    candidateId: "",
    title,
    titleQuote: title,
    descriptionQuote: lab
      ? "Hands-on TypeScript workshops for engineers building agent projects."
      : "Small engineering teams demonstrate their early-stage agent products.",
    month: date.month,
    day: date.day,
    year: date.year,
    weekday: dayName,
    dateQuote,
    yearQuote: null,
    startTime: "17:00",
    endTime: "21:00",
    timeQuote: "5:00 PM – 9:00 PM PT",
    timeZone: "PT",
    venue: "Fixture Hall",
    address: "123 Example Street",
    locationQuote: "Fixture Hall, 123 Example Street, San Francisco, CA",
    visibility: "public",
    visibilityQuote: "Fixture Hall, 123 Example Street, San Francisco, CA",
    priceKind: lab ? "paid" : "free",
    priceAmount: lab ? 25 : 0,
    priceQuote: lab ? "Admission $25" : "Admission Free",
    registration: past ? "past" : "approval_required",
    registrationQuote: past ? "Past Event" : "Registration Approval Required",
    attendance: "in_person",
    attendanceQuote: "Attendance: In person",
    pageKind: "event",
    explicitSession: true,
    registrationPlatform: null,
    registrationLinkQuote: null,
    ambiguities: [],
  };
  const text = [
    title,
    dateQuote,
    event.timeQuote,
    event.locationQuote,
    event.priceQuote,
    event.registrationQuote,
    event.attendanceQuote,
    event.descriptionQuote,
  ].join("\n");
  return { event, text, title };
}
