import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email({ error: "Enter a valid email address." }))
  .transform((email) => email.toLowerCase());
export const authRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("continue"),
      email: emailSchema,
    })
    .strict(),
  z.object({ action: z.literal("logout") }).strict(),
]);
export type Account = { id: string; email: string; emailVerified: boolean };
export const LOGIN_MAX_AGE = 60 * 60 * 24 * 30;
