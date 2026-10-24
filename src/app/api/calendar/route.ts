import { NextRequest } from "next/server";
import { calendarActionSchema } from "@/lib/domain/calendar";
import { calendarFailure } from "@/lib/server/calendar-http";
import {
  calendarStatus,
  disconnectCalendar,
  selectCalendars,
  syncCalendar,
} from "@/lib/server/calendar-service";
import { json, readJson, sameOrigin, SESSION_COOKIE } from "@/lib/server/http";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    getStore().requireAccount(
      request.cookies.get(SESSION_COOKIE)?.value,
      request.headers.get("x-sidekick-account"),
    );
    return json(
      calendarStatus(getStore(), request.cookies.get(SESSION_COOKIE)?.value),
    );
  } catch (error) {
    return calendarFailure(error);
  }
}

export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return json(
      {
        code: "invalid_origin",
        message: "Open your calendar connection in SF Sidekick.",
      },
      403,
    );
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return json(
      { code: "invalid_content_type", message: "Invalid calendar request." },
      415,
    );
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return json(
      { code: "invalid_body", message: "Could not read the calendar request." },
      400,
    );
  }
  const parsed = calendarActionSchema.safeParse(body);
  if (!parsed.success)
    return json(
      { code: "invalid_request", message: "Invalid calendar request." },
      400,
    );
  const store = getStore(),
    token = request.cookies.get(SESSION_COOKIE)?.value;
  try {
    store.requireAccount(token, request.headers.get("x-sidekick-account"));
    const input = parsed.data;
    if (input.action === "sync") return json(await syncCalendar(store, token));
    if (input.action === "select")
      return json(
        selectCalendars(store, token, input.revision, input.calendarIds),
      );
    return json(await disconnectCalendar(store, token, input.revision));
  } catch (error) {
    return calendarFailure(error);
  }
}
