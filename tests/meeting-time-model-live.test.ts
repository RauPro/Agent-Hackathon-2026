import { describe, expect, it } from "vitest";
import { interpretMeetingTime } from "../src/lib/server/meeting-time-model";

describe.skipIf(process.env.LIVE_MEETING_TIMES !== "1")("live meeting time interpretation", () => {
  const trip = { city: "San Francisco", start: "2026-11-01", end: "2026-11-15", timezone: "America/Los_Angeles" } as const;
  it("reads a natural time preference without approving or booking", async () => {
    const result = await interpretMeetingTime("November 4, from 2pm until 4pm works for me.", {}, trip);
    expect(result.question).toBeNull();
    expect(result.windows).toEqual([{ start: "2026-11-04T22:00:00.000Z", end: "2026-11-05T00:00:00.000Z" }]);
  }, 30000);
  it("clarifies a vague preference instead of inventing calendar availability", async () => {
    const result = await interpretMeetingTime("Maybe some afternoon, I don't know which day yet.", {}, trip);
    expect(result.windows).toEqual([]);
    expect(result.question).toBeTruthy();
  }, 30000);
  it("retains the date when the owner answers a follow-up about time", async () => {
    const result = await interpretMeetingTime("From 2 to 4 pm.", {}, trip, [
      { role: "user", content: "November 4 would work." },
      { role: "assistant", content: "What time could you meet, and until when?" },
    ]);
    expect(result.question).toBeNull();
    expect(result.windows).toEqual([{ start: "2026-11-04T22:00:00.000Z", end: "2026-11-05T00:00:00.000Z" }]);
  }, 30000);
});
