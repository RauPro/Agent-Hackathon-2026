import { describe, expect, it } from "vitest";
import {
  contextSchema,
  saveContextSchema,
  windowInstants,
} from "../src/lib/domain/context";
import { validContext } from "./fixtures";

describe("confirmed onboarding context", () => {
  it("keeps unknown availability distinct from an explicit absence of commitments", () => {
    const context = validContext();
    context.commitments.status = "none";
    const result = contextSchema.parse(context);
    expect(result.availability.status).toBe("unknown");
    expect(result.commitments.status).toBe("none");
  });

  it("rejects invalid, inverted dates and accepts a one-day visit", () => {
    const context = validContext();
    context.trip.end = "2026-10-23";
    expect(contextSchema.safeParse(context).success).toBe(false);
    context.trip.end = context.trip.start;
    expect(contextSchema.safeParse(context).success).toBe(true);
    context.trip.start = "2026-02-30";
    expect(contextSchema.safeParse(context).success).toBe(false);
  });

  it("requires complete windows inside the trip with increasing, nonoverlapping times", () => {
    const context = validContext();
    context.availability = { status: "provided", windows: [] };
    expect(contextSchema.safeParse(context).success).toBe(false);
    context.availability.windows = [
      { date: "2026-10-23", start: "15:00", end: "16:00" },
    ];
    expect(contextSchema.safeParse(context).success).toBe(false);
    context.availability.windows[0] = {
      date: "2026-10-26",
      start: "16:00",
      end: "15:00",
    };
    expect(contextSchema.safeParse(context).success).toBe(false);
    context.availability.windows[0] = {
      date: "2026-10-26",
      start: "15:00",
      end: "16:00",
    };
    context.availability.windows.push({
      date: "2026-10-26",
      start: "15:30",
      end: "17:00",
    });
    expect(contextSchema.safeParse(context).success).toBe(false);
    context.availability.windows[1].start = "16:00";
    expect(contextSchema.safeParse(context).success).toBe(true);
  });

  it("rejects hidden schedules in unknown/none states and empty commitments", () => {
    const context = validContext();
    context.commitments = {
      status: "none",
      items: [
        { title: "Dinner", date: "2026-10-26", start: "18:00", end: "19:00" },
      ],
    };
    expect(contextSchema.safeParse(context).success).toBe(false);
    context.commitments = { status: "provided", items: [] };
    expect(contextSchema.safeParse(context).success).toBe(false);
  });

  it("rejects an ambiguous SF fall-back hour and normalizes both offsets correctly", () => {
    const context = validContext();
    context.availability = {
      status: "provided",
      windows: [{ date: "2026-11-01", start: "01:30", end: "02:30" }],
    };
    expect(contextSchema.safeParse(context).success).toBe(false);
    expect(
      new Date(
        windowInstants({
          date: "2026-10-26",
          start: "15:30",
          end: "16:00",
        }).start,
      ).toISOString(),
    ).toBe("2026-10-26T22:30:00.000Z");
    expect(
      new Date(
        windowInstants({
          date: "2026-11-02",
          start: "15:30",
          end: "16:00",
        }).start,
      ).toISOString(),
    ).toBe("2026-11-02T23:30:00.000Z");
  });

  it("rejects spring-forward times and unsupported timezones", () => {
    const context = validContext();
    context.trip = { ...context.trip, start: "2027-03-13", end: "2027-03-15" };
    context.availability = {
      status: "provided",
      windows: [{ date: "2027-03-14", start: "02:15", end: "03:30" }],
    };
    expect(contextSchema.safeParse(context).success).toBe(false);
    expect(
      contextSchema.safeParse({
        ...validContext(),
        trip: { ...validContext().trip, timezone: "Europe/Madrid" },
      }).success,
    ).toBe(false);
  });

  it("requires explicit confirmation and rejects client-supplied identity", () => {
    const request = {
      context: validContext(),
      baseRevision: 0,
      requestId: crypto.randomUUID(),
      confirmed: true,
    };
    expect(saveContextSchema.safeParse(request).success).toBe(true);
    expect(
      saveContextSchema.safeParse({ ...request, confirmed: false }).success,
    ).toBe(false);
    expect(
      saveContextSchema.safeParse({ ...request, sessionId: "someone-else" })
        .success,
    ).toBe(false);
  });
});
