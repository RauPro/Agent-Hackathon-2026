import { isStoreError, getStore } from "@/lib/server/store";

import { NextRequest, NextResponse } from "next/server";
import { calendarFailure } from "@/lib/server/calendar-http";
import { finishCalendarConnection } from "@/lib/server/calendar-service";
import {
  CalendarError,
  googleCalendarConfig,
} from "@/lib/server/google-calendar";
import { SESSION_COOKIE } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const config = googleCalendarConfig();
  if (!config) return calendarFailure(new CalendarError("not_configured"));
  let target = new URL("/onboarding", config.origin);
  let token: string | undefined;
  try {
    await getStore().requireAccount(
      request.cookies.get(SESSION_COOKIE)?.value,
      request.headers.get("x-sidekick-account"),
    );
    token = await finishCalendarConnection(
      getStore(),
      request.cookies.get(SESSION_COOKIE)?.value,
      request.nextUrl.searchParams.get("state") || "",
      request.nextUrl.searchParams.get("code"),
      request.nextUrl.searchParams.has("error"),
      (path) => { target = new URL(path, config.origin); },
    );
  } catch (error) {
    const code =
      error instanceof CalendarError || isStoreError(error, "calendar_conflict")
        ? error.code
        : "sync_failed";
    target.searchParams.set("calendar", code);
  }
  const response = NextResponse.redirect(target, 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  if (token)
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.origin.startsWith("https:"),
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
  return response;
}
