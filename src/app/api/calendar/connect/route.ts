import { NextRequest } from "next/server";
import { calendarFailure } from "@/lib/server/calendar-http";
import { beginCalendarConnection } from "@/lib/server/calendar-service";
import {
  CalendarError,
  googleCalendarConfig,
} from "@/lib/server/google-calendar";
import { json, sameOrigin, SESSION_COOKIE } from "@/lib/server/http";
import { getStore, SessionMissing } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return json(
      {
        code: "invalid_origin",
        message: "Open your calendar connection in SF Sidekick.",
      },
      403,
    );
  try {
    const config = googleCalendarConfig();
    if (!config) throw new CalendarError("not_configured");
    if (request.headers.get("origin") !== config.origin)
      return json(
        {
          code: "wrong_origin",
          message: `Open SF Sidekick at ${config.origin} to connect Google Calendar.`,
        },
        400,
      );
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    if (!token) throw new SessionMissing();
    const response = json({ url: beginCalendarConnection(getStore(), token) });
    // Lax permits the top-level callback from Google; POST mutations check Origin.
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: config.origin.startsWith("https:"),
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return response;
  } catch (error) {
    return calendarFailure(error);
  }
}
