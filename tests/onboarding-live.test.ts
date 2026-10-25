import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { completeOnboarding } from "../src/lib/server/onboarding-model";
import {
  draftFromContext,
  initialChat,
  validateDraft,
  type ChatState,
  type ModelReply,
} from "../src/lib/domain/onboarding-chat";
import { validContext } from "./fixtures";

// Opt-in only: calls the real provider with fictional profiles, never the app DB.
const enabled = process.env.LIVE_ONBOARDING_EVAL === "1";
const results: {
  scenario: string;
  message: string;
  reply: ModelReply | null;
  passed: boolean;
}[] = [];
const technicalFormat = /\bISO\b|yyyy|hh:mm|trip window|schema/i;
const availabilityRequest =
  /(?:what|when|share|provide|send|tell|give).{0,80}(?:availability|free slots|free times)|(?:availability windows|available time slots)/i;

function profile(withDates = false): ChatState {
  const chat = initialChat({
    context: null,
    revision: 0,
    confirmedAt: null,
    evidenceKind: null,
  });
  chat.draft = draftFromContext(validContext());
  chat.draft.arrival = withDates ? "2026-11-01" : "";
  chat.draft.departure = withDates ? "2026-11-20" : "";
  return chat;
}
async function check(
  scenario: string,
  chat: ChatState,
  message: string,
  assertions: (result: ModelReply) => void,
) {
  const record: (typeof results)[number] = {
    scenario,
    message,
    reply: null,
    passed: false,
  };
  results.push(record);
  const reply = await completeOnboarding(chat, message);
  record.reply = reply;
  expect(reply.reply).not.toMatch(technicalFormat);
  expect(reply.reply).not.toMatch(availabilityRequest);
  expect(reply.reply.match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(1);
  if (chat.draft.name) {
    expect(reply.draft.name).toBe(chat.draft.name);
    expect(reply.reply).not.toMatch(
      /(?:what(?:'s|’s| is)|tell me).{0,30}\bname\b/i,
    );
  }
  if (
    validateDraft(reply.draft, reply.profileGaps).success &&
    reply.draft.commitments.status !== "unknown"
  )
    expect(reply.reply).not.toContain("?");
  assertions(reply);
  record.passed = true;
}

describe.skipIf(!enabled)("live onboarding conversation regressions", () => {
  beforeAll(() => {
    process.loadEnvFile(".env.local");
    if (!process.env.OPENAI_API_KEY)
      throw new Error("OpenAI is not configured for the live evaluation.");
    if (
      process.env.OPENAI_BASE_URL &&
      new URL(process.env.OPENAI_BASE_URL).hostname !== "api.openai.com"
    )
      throw new Error("The live evaluation requires the real OpenAI endpoint.");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-24T12:00:00-07:00"));
  });
  afterAll(() => {
    vi.useRealTimers();
    if (process.env.ONBOARDING_EVAL_OUTPUT)
      writeFileSync(
        process.env.ONBOARDING_EVAL_OUTPUT,
        JSON.stringify(
          {
            testedAt: new Date().toISOString(),
            provider: "OpenAI live",
            model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
            contextDate: "2026-10-24 in America/Los_Angeles",
            fixture: "Fictional Alex Rivera profiles; no user account data",
            results,
          },
          null,
          2,
        ) + "\n",
      );
  });

  it("probes a generic profile and resolves gaps from concrete follow-ups", async () => {
    const chat = profile(true);
    chat.draft.bio = "I work in tech and enjoy innovation.";
    chat.draft.offers = "I can help with anything.";
    chat.draft.goalText = "I want to network and meet people.";
    const first = await completeOnboarding(chat, "Anything is fine. Just confirm my profile.");
    expect(first.profileGaps.length).toBeGreaterThan(0);
    expect(validateDraft(first.draft, first.profileGaps).success).toBe(false);
    expect(first.reply).toContain("?");
    chat.draft = first.draft;
    chat.profileGaps = first.profileGaps;
    chat.messages.push({ id: "follow-up", role: "assistant", content: first.reply });
    const repeated = await completeOnboarding(chat, "I'm not sure. Anything in tech, I guess.");
    expect(repeated.profileGaps.length).toBeGreaterThan(0);
    expect(validateDraft(repeated.draft, repeated.profileGaps).success).toBe(false);
    expect(repeated.reply).toContain("?");
    expect(repeated.reply).not.toBe(first.reply);
    chat.draft = repeated.draft;
    chat.profileGaps = repeated.profileGaps;
    chat.messages.push(
      { id: "still-vague", role: "user", content: "I'm not sure. Anything in tech, I guess." },
      { id: "narrower-follow-up", role: "assistant", content: repeated.reply },
    );
    await check("specific follow-up after generic profile", chat,
      "I build BIM coordination tools for architects. I can review Revit plugins. I want to meet architecture firm owners to find two pilot customers for my clash detection tool. No additional commitments.",
      (result) => {
        expect(result.profileGaps).toEqual([]);
        expect(result.draft.goalType).toBe("customers");
        expect(validateDraft(result.draft, result.profileGaps).success).toBe(true);
      },
    );
  }, 60000);

  it("asks directly for the full name once the goal is specific", async () => {
    const chat = initialChat({
      context: null,
      revision: 0,
      confirmedAt: null,
      evidenceKind: null,
    });
    await check(
      "full name",
      chat,
      "I'm looking for a founding engineer role on a robotics team building warehouse automation.",
      (result) => {
        expect(result.reply).toMatch(/^what(?:'s|’s| is) your full name\?$/i);
        expect(result.draft.name).toBe("");
        expect(result.draft.goalType).toBe("seeking_role");
      },
    );
  }, 30000);

  it("understands the November range even after an earlier assistant requested ISO dates", async () => {
    const chat = profile();
    chat.messages.push({
      id: "previous-mistake",
      role: "assistant",
      content:
        "Please send your arrival and departure dates as YYYY-MM-DD. You can also share availability windows.",
    });
    await check(
      "recover from formatting request",
      chat,
      "from 1 nov to 20 nov, no commitments so far",
      (result) => {
        expect(result.draft.arrival).toBe("2026-11-01");
        expect(result.draft.departure).toBe("2026-11-20");
        expect(result.draft.commitments).toEqual({ status: "none", items: [] });
        expect(result.draft.availability).toEqual({
          status: "unknown",
          windows: [],
        });
        expect(validateDraft(result.draft).success).toBe(true);
        expect(result.reply).not.toContain("?");
        expect(result.reply).toMatch(/2026/);
      },
    );
  }, 30000);

  it("reuses dates from the existing conversation when the user continues", async () => {
    const chat = profile();
    chat.messages.push(
      {
        id: "already-answered",
        role: "user",
        content: "from 1 nov to 20 nov, no commitments so far",
      },
      {
        id: "bad-format-request",
        role: "assistant",
        content:
          "Please send your arrival and departure dates in ISO format, YYYY-MM-DD.",
      },
    );
    await check(
      "continue after earlier mistake",
      chat,
      "Continue.",
      (result) => {
        expect(result.draft.arrival).toBe("2026-11-01");
        expect(result.draft.departure).toBe("2026-11-20");
        expect(result.draft.commitments.status).toBe("none");
        expect(result.draft.availability.status).toBe("unknown");
      },
    );
  }, 30000);

  it("interprets a trip spanning New Year", async () => {
    await check(
      "year boundary",
      profile(),
      "I'll arrive December 28 and leave January 3. Nothing planned outside my calendar.",
      (result) => {
        expect(result.draft.arrival).toBe("2026-12-28");
        expect(result.draft.departure).toBe("2027-01-03");
        expect(result.draft.availability.status).toBe("unknown");
      },
    );
  }, 30000);

  it("preserves explicitly supplied years instead of moving the dates forward", async () => {
    await check(
      "explicit past year",
      profile(),
      "My trip was November 1 to November 20, 2025.",
      (result) => {
        expect(result.draft.arrival).toBe("2025-11-01");
        expect(result.draft.departure).toBe("2025-11-20");
      },
    );
  }, 30000);

  it("clarifies genuinely ambiguous numeric dates in ordinary language", async () => {
    await check(
      "ambiguous date order",
      profile(),
      "I'll be there from 04/05 to 04/10.",
      (result) => {
        expect(result.reply).toContain("?");
        expect(result.reply).toMatch(/April|May|October|month|day/i);
        expect(validateDraft(result.draft).success).toBe(false);
      },
    );
  }, 30000);

  it("asks only about commitments outside Google Calendar", async () => {
    await check(
      "additional commitments",
      profile(true),
      "Anything else you need about my schedule?",
      (result) => {
        expect(result.reply).toMatch(/calendar/i);
        expect(result.reply).toMatch(/outside|not|isn't|isn’t|aren't|aren’t/i);
        expect(result.draft.availability).toEqual({
          status: "unknown",
          windows: [],
        });
      },
    );
  }, 30000);

  it("extracts an outside-calendar commitment without inventing free time", async () => {
    await check(
      "outside-calendar dinner",
      profile(true),
      "I have dinner November 5 from 6 pm to 8 pm that isn't in my Google Calendar.",
      (result) => {
        expect(result.draft.commitments.status).toBe("provided");
        expect(result.draft.commitments.items).toEqual([
          expect.objectContaining({
            date: "2026-11-05",
            start: "18:00",
            end: "20:00",
          }),
        ]);
        expect(result.draft.availability).toEqual({
          status: "unknown",
          windows: [],
        });
        expect(validateDraft(result.draft).success).toBe(true);
      },
    );
  }, 30000);

  it("retains volunteered meeting preferences without treating them as calendar availability", async () => {
    const chat = profile(true);
    chat.draft.availability = {
      status: "provided",
      windows: [{ date: "2026-11-04", start: "14:00", end: "16:00" }],
    };
    await check(
      "preserve volunteered preferences",
      chat,
      "No other commitments outside Google Calendar.",
      (result) => {
        expect(result.draft.availability).toEqual(chat.draft.availability);
        expect(result.draft.commitments.status).toBe("none");
      },
    );
  }, 30000);
});
