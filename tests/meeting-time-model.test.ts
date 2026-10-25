import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateMeetingInterpretation } from "../src/lib/server/meeting-time-model";

const trip = { city: "San Francisco", start: "2026-11-01", end: "2026-11-15", timezone: "America/Los_Angeles" } as const;
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-24T18:00:00Z")); });
afterEach(() => vi.useRealTimers());

describe("meeting time interpretation boundary", () => {
  it("converts explicitly offered SF times with the correct DST offset", () => {
    const result = validateMeetingInterpretation({ clarification: "none", windows: [{ date: "2026-11-04", start: "14:00", end: "16:00" }] }, trip);
    expect(result).toEqual({ question: null, windows: [{ start: "2026-11-04T22:00:00.000Z", end: "2026-11-05T00:00:00.000Z" }] });
  });
  it("asks a question rather than applying a partly ambiguous answer", () => {
    const result = validateMeetingInterpretation({ clarification: "ambiguous", windows: [{ date: "2026-11-04", start: "14:00", end: "16:00" }] }, trip);
    expect(result.windows).toEqual([]);
    expect(result.question).toContain("Which day");
  });
  it.each([
    { date: "2026-11-16", start: "14:00", end: "16:00" },
    { date: "2026-11-04", start: "14:00", end: "13:00" },
    { date: "2026-11-04", start: "14:00", end: "14:15" },
    { date: "2026-11-01", start: "01:15", end: "02:15" },
  ])("rejects outside-stay, too-short, reversed and ambiguous DST windows: %j", (window) => {
    expect(validateMeetingInterpretation({ clarification: "none", windows: [window] }, trip).windows).toEqual([]);
  });
  it("rejects model output that tries to introduce another action", () => {
    expect(() => validateMeetingInterpretation({ clarification: "none", windows: [], action: "approve" }, trip)).toThrow();
  });
});
