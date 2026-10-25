import { z } from "zod";
import type { SharedProfile } from "./network";

export const DIALOGUE_MIN_TURNS = 4;
export const DIALOGUE_TURN_LIMIT = 6;
export type DialogueStatus =
  | "awaiting_profile"
  | "awaiting_sharing"
  | "queued"
  | "running"
  | "needs_user"
  | "completed"
  | "paused"
  | "error"
  | "revoked";

export type DialogueTurn = {
  id: string;
  actorUserId: string;
  kind: "agent" | "user";
  text: string;
  at: string;
};

export type AgentDialogue = {
  id: string;
  userId: string;
  name: string;
  revision: number;
  status: DialogueStatus;
  statusDetail: string;
  turns: DialogueTurn[];
  waitingForUserId: string | null;
  question: string | null;
  suggestion: string | null;
  pausedByUserId: string | null;
  ownProfileReady: boolean;
  ownSharingReady: boolean;
  updatedAt: string;
};

export const dialogueReplySchema = z.object({
  message: z.string().min(1).max(1800),
  next: z.enum(["continue", "ask_user", "complete"]),
  questionForUser: z.string().min(1).max(500).nullable(),
  suggestedNextStep: z.string().min(1).max(500).nullable(),
}).strict();
export type DialogueReply = z.infer<typeof dialogueReplySchema>;

// Both profiles must already be projected for the other participant. Never pass
// raw private context, calendar records, account email or onboarding messages.
export type DialogueModelInput = {
  self: SharedProfile;
  peer: SharedProfile;
  history: Array<{ speaker: "self" | "peer" | "user"; text: string }>;
  turnNumber: number;
  turnLimit: number;
};
export type DialogueCompleter = (input: DialogueModelInput) => Promise<DialogueReply>;

export const dialogueActionSchema = z.object({
  action: z.literal("dialogue"),
  toUserId: z.uuid(),
  revision: z.number().int().nonnegative(),
  operation: z.enum(["answer", "decline", "pause", "resume", "retry"]),
  answer: z.string().trim().min(1).max(2000).optional(),
}).strict().refine((value) => value.operation === "answer" ? !!value.answer : !value.answer,
  "Provide an answer only when sharing an answer.");
export type DialogueAction = z.infer<typeof dialogueActionSchema>;
