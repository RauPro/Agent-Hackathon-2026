import { z } from "zod";
import type { UserContext } from "./context";

export const NETWORK_FIELDS = ["profile", "goal", "trip", "events"] as const;
export type NetworkField = (typeof NETWORK_FIELDS)[number];
export const visibilitySchema = z.enum(["private", "friends", "network"]);
export type Visibility = z.infer<typeof visibilitySchema>;
export const networkVisibilitySchema = z
  .object({
    profile: visibilitySchema,
    goal: visibilitySchema,
    trip: visibilitySchema,
    events: visibilitySchema,
  })
  .strict();
export const networkSettingsSchema = z
  .object({
    discoverable: z.boolean(),
    visibility: networkVisibilitySchema,
    area: z.string().trim().max(80).nullable(),
    revision: z.number().int().min(0),
  })
  .strict();
export type NetworkSettingsInput = z.infer<typeof networkSettingsSchema>;
export type NetworkSettings = NetworkSettingsInput & { qrToken: string };
export type SharedEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  area?: string | null;
  sourceMode: "user_report" | "demo";
};
export type SharedProfile = {
  id: string;
  name: string;
  revision: number;
  profile?: UserContext["profile"];
  goal?: UserContext["goal"];
  trip?: UserContext["trip"];
  area?: string | null;
  events?: SharedEvent[];
};
export type ConnectionAction =
  | "accept"
  | "decline"
  | "remove"
  | "block"
  | "unblock";
export type ConnectionView = {
  userId: string;
  name: string;
  status: "pending" | "accepted" | "removed" | "blocked";
  direction: "incoming" | "outgoing";
  context: string;
  source: "qr" | "opportunity";
  createdAt: string;
  updatedAt: string;
};
export const connectionRequestSchema = z
  .object({
    source: z.enum(["qr", "opportunity"]),
    token: z.string().min(32).max(128).optional(),
    context: z.string().trim().max(500),
  })
  .strict();
export type ConnectionRequest = z.infer<typeof connectionRequestSchema>;
export const informationRequestSchema = z
  .object({
    toUserId: z.uuid(),
    requestId: z.uuid(),
    fields: z
      .array(z.enum(NETWORK_FIELDS))
      .min(1)
      .max(4)
      .refine(
        (fields) => new Set(fields).size === fields.length,
        "Request each field only once.",
      ),
    purpose: z.string().trim().min(10).max(500),
  })
  .strict();
export type InformationRequest = z.infer<typeof informationRequestSchema>;
export const informationAnswerSchema = z
  .object({
    messageId: z.uuid(),
    answers: z
      .object({
        profile: z.string().trim().min(1).max(2000).optional(),
        goal: z.string().trim().min(1).max(2000).optional(),
        trip: z.string().trim().min(1).max(2000).optional(),
        events: z.string().trim().min(1).max(2000).optional(),
      })
      .strict(),
    decline: z.boolean(),
  })
  .strict()
  .refine(
    (input) =>
      input.decline
        ? !Object.keys(input.answers).length
        : !!Object.keys(input.answers).length,
    "Share an answer or decline the request.",
  );
export type InformationAnswer = z.infer<typeof informationAnswerSchema>;
export type InformationResult = {
  status: "shared" | "not_shared" | "unknown";
  value?:
    | UserContext["profile"]
    | UserContext["goal"]
    | UserContext["trip"]
    | SharedEvent[]
    | string;
  source?: "confirmed_profile" | "user_answer";
};
export type AgentMessage = {
  id: string;
  correlationId: string;
  senderAgentId: string;
  recipientAgentId: string;
  representedUserId: string;
  fromUserId: string;
  toUserId: string;
  senderName: string;
  recipientName: string;
  type: "PROFILE_QUERY";
  fields: NetworkField[];
  purpose: string;
  status: "needs_user" | "completed" | "declined" | "expired" | "revoked";
  response: Partial<Record<NetworkField, InformationResult>>;
  createdAt: string;
  expiresAt: string;
};
