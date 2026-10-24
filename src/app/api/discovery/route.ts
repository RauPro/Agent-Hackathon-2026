import { after, NextRequest } from "next/server";
import {
  isDiscoveryError,
  discoveryRequestSchema,
} from "@/lib/domain/discovery";
import {
  discoveryStatus,
  startDiscovery,
} from "@/lib/server/discovery-service";
import { json, readJson, sameOrigin, SESSION_COOKIE } from "@/lib/server/http";
import { getStore, isStoreError } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
function failure(error: unknown) {
  if (isStoreError(error, "session_missing"))
    return json(
      {
        code: "session_missing",
        message: "Sign in to see events for your goal.",
      },
      401,
    );
  if (isDiscoveryError(error)) {
    const errors = {
      profile_missing: [400, "Confirm your profile to find events."],
      trip_past: [
        400,
        "Your saved trip has ended. Confirm new dates to find events.",
      ],
      profile_changed: [
        409,
        "Your saved profile changed. Reload to see events for it.",
      ],
      busy: [429, "Event discovery is busy. Try again in a moment."],
      refresh_limit: [
        429,
        "You've reached the refresh limit. Try again in 24 hours.",
      ],
      not_configured: [503, "Event discovery setup is pending."],
      daily_limit: [
        429,
        "Event discovery is paused for today. You can still connect Google Calendar.",
      ],
    } as const;
    return json(
      { code: error.code, message: errors[error.code][1] },
      errors[error.code][0],
    );
  }
  return json(
    {
      code: "unavailable",
      message: "Couldn't check event sources. Try again.",
    },
    503,
  );
}
export async function GET(request: NextRequest) {
  try {
    const store = getStore(),
      token = request.cookies.get(SESSION_COOKIE)?.value;
    store.requireAccount(token, request.headers.get("x-sidekick-account"));
    return json(discoveryStatus(store, token));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  if (!sameOrigin(request))
    return json(
      {
        code: "invalid_origin",
        message: "Open event discovery in SF Sidekick.",
      },
      403,
    );
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return json(
      { code: "invalid_content_type", message: "Invalid request format." },
      415,
    );
  let body: unknown;
  try {
    body = await readJson(request);
  } catch {
    return json(
      { code: "invalid_request", message: "The request could not be read." },
      400,
    );
  }
  const parsed = discoveryRequestSchema.safeParse(body);
  if (!parsed.success)
    return json(
      {
        code: "invalid_request",
        message: "Reload your saved profile and try again.",
      },
      400,
    );
  try {
    const store = getStore(),
      token = request.cookies.get(SESSION_COOKIE)?.value;
    store.requireAccount(token, request.headers.get("x-sidekick-account"));
    const started = startDiscovery(store, token, parsed.data);
    if (started.run) after(started.run);
    return json(
      started.view,
      started.view.discovery?.status === "running" ? 202 : 200,
    );
  } catch (error) {
    return failure(error);
  }
}
