import type { NextRequest } from "next/server";
import { ZodError } from "zod";
import { getStore, isStoreError } from "./store";
import { json, readJson, sameOrigin, SESSION_COOKIE } from "./http";

export function networkAccount(request: NextRequest) {
  return getStore().requireAccount(
    request.cookies.get(SESSION_COOKIE)?.value,
    request.headers.get("x-sidekick-account"),
  );
}
export async function networkBody(request: NextRequest) {
  if (!sameOrigin(request))
    throw Object.assign(new Error("Open Sidekick to perform this action."), {
      kind: "network_error",
      code: "invalid_origin",
      status: 403,
    });
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw Object.assign(new Error("Use JSON for this request."), {
      kind: "network_error",
      code: "invalid_body",
      status: 415,
    });
  return readJson(request);
}
export function networkFailure(error: unknown) {
  if (isStoreError(error, "session_missing"))
    return json(
      { code: "session_missing", message: "Sign in to continue." },
      401,
    );
  if (error instanceof ZodError)
    return json(
      {
        code: "invalid_request",
        message: error.issues[0]?.message ?? "Review your request.",
      },
      400,
    );
  if (
    error instanceof Error &&
    "kind" in error &&
    "code" in error &&
    ["network_error", "meeting_error"].includes(String(error.kind))
  ) {
    const status =
      "status" in error && typeof error.status === "number"
        ? error.status
        : 400;
    return json({ code: error.code, message: error.message }, status);
  }
  if (
    error instanceof Error &&
    ["invalid_json", "payload_too_large"].includes(error.message)
  )
    return json(
      {
        code: "invalid_request",
        message: "The request could not be read or is too large.",
      },
      400,
    );
  console.error("network_request_failed");
  return json(
    {
      code: "unavailable",
      message: "Could not complete this action. Try again.",
    },
    503,
  );
}
