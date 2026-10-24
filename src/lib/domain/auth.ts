import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email({ error: "Enter a valid email address." }))
  .transform((email) => email.toLowerCase());
const password = z
  .string()
  .min(1, "Enter your password.")
  .max(128, "Use no more than 128 characters.");
export const authRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("register"),
      email: emailSchema,
      password: password.min(15, "Use at least 15 characters."),
    })
    .strict(),
  z
    .object({ action: z.literal("login"), email: emailSchema, password })
    .strict(),
  z.object({ action: z.literal("logout") }).strict(),
]);
export type Account = { id: string; email: string; emailVerified: boolean };
export const LOGIN_MAX_AGE = 60 * 60 * 24 * 30;
