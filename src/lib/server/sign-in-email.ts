import { networkDemoEnabled } from "./demo-mode";

export type SignInDelivery = "email" | "inline" | "unconfigured";

// Codes are shown in the response only for local development and the fictional demo database.
export function signInDelivery(): SignInDelivery {
  if (process.env.RESEND_API_KEY?.trim() && process.env.AUTH_EMAIL_FROM?.trim())
    return "email";
  if (process.env.NODE_ENV !== "production" || networkDemoEnabled())
    return "inline";
  return "unconfigured";
}

export async function sendSignInCode(email: string, code: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.AUTH_EMAIL_FROM!.trim(),
      to: [email],
      subject: `${code} is your SF Sidekick code`,
      text: `Your SF Sidekick sign-in code is ${code}.\n\nIt expires in 10 minutes. If you did not request it, you can ignore this email.`,
    }),
  });
  if (!response.ok) throw new Error(`sign_in_email_${response.status}`);
}
