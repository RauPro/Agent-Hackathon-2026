import { z } from "zod";
import {
  contextSchema,
  emptyContext,
  type ContextState,
  type UserContext,
} from "./context";

// A draft may be incomplete. It becomes a profile only after domain validation
// and a separate, explicit user confirmation.
const slot = z
  .object({
    date: z.string().max(10),
    start: z.string().max(5),
    end: z.string().max(5),
  })
  .strict();
export const draftSchema = z
  .object({
    name: z.string().max(80),
    bio: z.string().max(2000),
    offers: z.string().max(1000),
    goalType: z
      .enum(["seeking_role", "hiring", "customers", "collaborators"])
      .nullable(),
    goalText: z.string().max(1000),
    arrival: z.string().max(10),
    departure: z.string().max(10),
    availability: z
      .object({
        status: z.enum(["unknown", "provided"]),
        windows: z.array(slot).max(14),
      })
      .strict(),
    commitments: z
      .object({
        status: z.enum(["unknown", "none", "provided"]),
        items: z.array(slot.extend({ title: z.string().max(120) })).max(12),
      })
      .strict(),
    preferences: z
      .object({
        meetingFormat: z.enum(["any", "small_groups", "one_to_one"]),
        budgetUsd: z.number().min(0).max(10000).nullable(),
      })
      .strict(),
  })
  .strict();

export const modelReplySchema = z
  .object({ reply: z.string().min(1).max(1200), draft: draftSchema })
  .strict();
export type ProfileDraft = z.infer<typeof draftSchema>;
export type ModelReply = z.infer<typeof modelReplySchema>;
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};
export type ChatState = {
  revision: number;
  baseRevision: number;
  confirmed: boolean;
  draft: ProfileDraft;
  messages: ChatMessage[];
};

const requestBase = { requestId: z.uuid(), revision: z.number().int().min(0) };
export const chatRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...requestBase,
      action: z.literal("message"),
      message: z.string().trim().min(1).max(3000),
    })
    .strict(),
  z.object({ ...requestBase, action: z.literal("confirm") }).strict(),
  z.object({ ...requestBase, action: z.literal("reload_saved") }).strict(),
]);
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export function draftFromContext(context: UserContext | null): ProfileDraft {
  const value = context ?? emptyContext();
  return {
    name: value.profile.name,
    bio: value.profile.bio,
    offers: value.profile.offers,
    goalType: context ? value.goal.type : null,
    goalText: value.goal.text,
    arrival: value.trip.start,
    departure: value.trip.end,
    availability: value.availability,
    commitments: value.commitments,
    preferences: value.preferences,
  };
}

export function validateDraft(draft: ProfileDraft) {
  return contextSchema.safeParse({
    profile: { name: draft.name, bio: draft.bio, offers: draft.offers },
    goal: { type: draft.goalType, text: draft.goalText },
    trip: {
      city: "San Francisco",
      timezone: "America/Los_Angeles",
      start: draft.arrival,
      end: draft.departure,
    },
    availability: draft.availability,
    commitments: draft.commitments,
    preferences: draft.preferences,
  });
}

export function draftIssues(draft: ProfileDraft): string[] {
  const result = validateDraft(draft);
  if (result.success) return [];
  return [
    ...new Set(
      result.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    ),
  ];
}

const WELCOME = "What would you like to get out of your time in San Francisco?";
const WELCOME_BACK = "What would you like to update in your profile?";

// App-owned greeting copy can change without rewriting user or model messages.
export function refreshWelcome(chat: ChatState): ChatState {
  return {
    ...chat,
    messages: chat.messages.map((message) => {
      if (
        message.role !== "assistant" ||
        !["welcome", "welcome-back"].includes(message.id)
      )
        return message;
      const returning =
        message.id === "welcome-back" ||
        (chat.messages.length === 1 && chat.confirmed);
      return {
        ...message,
        id: returning ? "welcome-back" : "welcome",
        content: returning ? WELCOME_BACK : WELCOME,
      };
    }),
  };
}

export function initialChat(state: ContextState): ChatState {
  return {
    revision: 0,
    baseRevision: state.revision,
    confirmed: !!state.context,
    draft: draftFromContext(state.context),
    messages: [
      {
        id: state.context ? "welcome-back" : "welcome",
        role: "assistant",
        content: state.context ? WELCOME_BACK : WELCOME,
      },
    ],
  };
}
