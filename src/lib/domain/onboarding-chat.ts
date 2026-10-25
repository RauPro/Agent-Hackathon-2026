import { z } from "zod";
import { basicProfileGaps, PROFILE_FIELDS, PROFILE_QUESTIONS, type ProfileField } from "./profile-quality";
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
    arrival: z
      .string()
      .max(10)
      .describe(
        "Interpret natural arrival dates internally as YYYY-MM-DD. Leave empty when missing or ambiguous; never ask the user for this format.",
      ),
    departure: z
      .string()
      .max(10)
      .describe(
        "Interpret natural departure dates internally as YYYY-MM-DD. Leave empty when missing or ambiguous; never ask the user for this format.",
      ),
    availability: z
      .object({
        status: z.enum(["unknown", "provided"]),
        windows: z.array(slot).max(14),
      })
      .strict()
      .describe(
        "Only meeting-time preferences volunteered by the user. Never request availability windows; Google Calendar supplies actual availability separately.",
      ),
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
  // Extract the latest facts before composing the next question.
  .object({
    draft: draftSchema,
    profileGaps: z.array(z.enum(PROFILE_FIELDS)).max(3).describe(
      "Fields still missing useful specifics, evaluated from the updated draft and user-stated facts. bio needs a concrete skill, project, domain or responsibility; offers needs a specific contribution grounded in experience; goalText needs a target person/team/problem and desired outcome. Generic or uncertain answers remain gaps even when long. Empty array only when all three are specific enough."
    ),
    reply: z
      .string()
      .min(1)
      .max(1200)
      .describe(
        "A short English reply based on the updated draft. Ask one focused question about missing or vague information, using the user's context. If name is populated, do not ask for it again. Never request technical date formats or manual availability. Invite review only when required fields are valid and profileGaps is empty.",
      ),
  })
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
  // Optional for conversations saved before profile quality checks were introduced.
  profileGaps?: ProfileField[];
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

export function profileGaps(draft: ProfileDraft, assessed: ProfileField[] = []) {
  return [...new Set([...basicProfileGaps(draft), ...assessed])];
}

export function guardProfileReply(reply: ModelReply): ModelReply {
  const gaps = profileGaps(reply.draft, reply.profileGaps);
  const needsName = !reply.draft.name.trim() && reply.draft.goalType && !gaps.includes("goalText");
  return {
    ...reply,
    profileGaps: gaps,
    // A provider cannot invite confirmation while a required detail is vague.
    reply: needsName ? "What's your full name?" : gaps.length && !reply.reply.includes("?")
      ? PROFILE_QUESTIONS[gaps[0]]
      : reply.reply,
  };
}

export function validateDraft(draft: ProfileDraft, assessed: ProfileField[] = []) {
  return contextSchema.superRefine((_value, ctx) => {
    for (const field of profileGaps(draft, assessed)) {
      ctx.addIssue({
        code: "custom",
        path: field === "goalText" ? ["goal", "text"] : ["profile", field],
        message: PROFILE_QUESTIONS[field],
      });
    }
  }).safeParse({
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

export function draftIssues(draft: ProfileDraft, assessed: ProfileField[] = []): string[] {
  const result = validateDraft(draft, assessed);
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
