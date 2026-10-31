import { isStoreError, getStore } from "@/lib/server/store";

import { NextRequest } from "next/server";
import { authRequestSchema, LOGIN_MAX_AGE } from "@/lib/domain/auth";
import {
  deleteAccount,
  requestSignInCode,
  SignInUnavailable,
  verifySignIn,
} from "@/lib/server/auth-service";

import {
  clientIp,
  json,
  readJson,
  sameOrigin,
  SESSION_COOKIE,
} from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    return json({
      account: await getStore().account(
        request.cookies.get(SESSION_COOKIE)?.value,
      ),
    });
  } catch {
    return json({ message: "Could not load your account. Try again." }, 503);
  }
}

function withSession(
  response: ReturnType<typeof json>,
  request: NextRequest,
  token: string | null,
) {
  response.cookies.set(SESSION_COOKIE, token ?? "", {
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: token ? LOGIN_MAX_AGE : 0,
  });
  return response;
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return json({ message: "Open SF Sidekick to continue." }, 403);
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return json({ message: "Invalid account request." }, 415);
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return json({ message: "Could not read the account request." }, 400);
  }
  const parsed = authRequestSchema.safeParse(body);
  if (!parsed.success)
    return json(
      {
        message: "Check your email address and code.",
        errors: Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join("."),
            issue.message,
          ]),
        ),
      },
      400,
    );
  const store = getStore();
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  try {
    const data = parsed.data;
    if (data.action === "logout" || data.action === "delete_account") {
      const current = await store.account(token);
      const expected = request.headers.get("x-sidekick-account");
      if (current && expected && expected !== current.id)
        return json(
          { message: "Your account changed. Reload to continue." },
          401,
        );
      if (data.action === "delete_account") {
        if (!current || !expected)
          return json({ message: "Sign in again to delete your account." }, 401);
        await deleteAccount(store, token);
      } else await store.logout(token);
      return withSession(json({ account: null }), request, null);
    }
    if (data.action === "request_code") {
      const result = await requestSignInCode(
        store,
        data.email,
        token,
        clientIp(request),
      );
      return json({ sent: true, ...result });
    }
    const result = await verifySignIn(store, data.email, data.code, token);
    return withSession(
      json({ account: result.account }),
      request,
      result.token,
    );
  } catch (error) {
    if (isStoreError(error, "account_conflict"))
      return json(
        { message: "Sign out before continuing with another email." },
        409,
      );
    if (isStoreError(error, "auth_code_invalid"))
      return json(
        {
          message: "That code is incorrect or expired. Request a new code.",
          errors: { code: "Enter the latest 6-digit code from your email." },
        },
        400,
      );
    if (isStoreError(error, "auth_rate_limit")) {
      const response = json(
        { message: "Too many attempts. Try again in 15 minutes." },
        429,
      );
      response.headers.set("Retry-After", "900");
      return response;
    }
    if (isStoreError(error, "usage_limit"))
      return json(
        { message: "Sign-in emails are paused for today. Try again tomorrow." },
        429,
      );
    if (error instanceof SignInUnavailable)
      return json(
        { message: "Could not send a sign-in code. Try again later." },
        503,
      );
    return json({ message: "Could not complete the request. Try again." }, 503);
  }
}
