import { z } from "zod";

export const emailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email({ error: "Enter a valid email address." }))
  .transform((email) => email.toLowerCase());
export const signInCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, { error: "Enter the 6-digit code from your email." });
export const authRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("request_code"),
      email: emailSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("verify"),
      email: emailSchema,
      code: signInCodeSchema,
    })
    .strict(),
  z.object({ action: z.literal("logout") }).strict(),
  z.object({ action: z.literal("delete_account") }).strict(),
]);
export type AuthRequest = z.infer<typeof authRequestSchema>;
export type Account = { id: string; email: string; emailVerified: boolean };
export const LOGIN_MAX_AGE = 60 * 60 * 24 * 30;
export const SIGN_IN_CODE_TTL_MS = 10 * 60 * 1000;
export const SIGN_IN_CODE_MAX_ATTEMPTS = 5;
