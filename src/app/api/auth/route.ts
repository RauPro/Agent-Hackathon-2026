import { isStoreError, getStore } from "@/lib/server/store";

import { NextRequest } from "next/server";
import { authRequestSchema, LOGIN_MAX_AGE } from "@/lib/domain/auth";
import { authenticate, InvalidCredentials } from "@/lib/server/auth-service";

import { json, readJson, sameOrigin, SESSION_COOKIE } from "@/lib/server/http";

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
        message: "Check your email and password.",
        errors: Object.fromEntries(
          parsed.error.issues.map((issue) => [
            issue.path.join("."),
            issue.message,
          ]),
        ),
      },
      400,
    );
  try {
    const current = await getStore().account(
      request.cookies.get(SESSION_COOKIE)?.value,
    );
    if (
      parsed.data.action === "logout" &&
      current &&
      request.headers.get("x-sidekick-account") &&
      request.headers.get("x-sidekick-account") !== current.id
    )
      return json(
        { message: "Your account changed. Reload to continue." },
        401,
      );
    const result = await authenticate(
      getStore(),
      parsed.data,
      request.cookies.get(SESSION_COOKIE)?.value,
    );
    const response = json({ account: result?.account ?? null });
    response.cookies.set(SESSION_COOKIE, result?.token ?? "", {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: result ? LOGIN_MAX_AGE : 0,
    });
    return response;
  } catch (error) {
    if (error instanceof InvalidCredentials)
      return json({ message: "Email or password is incorrect." }, 401);
    if (isStoreError(error, "account_conflict"))
      return json(
        {
          message:
            "Could not create this account. Try signing in or use another email.",
        },
        409,
      );
    if (isStoreError(error, "auth_rate_limit")) {
      const response = json(
        { message: "Too many attempts. Try again in 15 minutes." },
        429,
      );
      response.headers.set("Retry-After", "900");
      return response;
    }
    return json({ message: "Could not complete the request. Try again." }, 503);
  }
}
