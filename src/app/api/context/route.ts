import { isStoreError, getStore } from "@/lib/server/store";

import { after, NextRequest } from "next/server";
import { drainNetworkWork } from "@/lib/server/network-worker";
import { fieldErrors, saveContextSchema } from "@/lib/domain/context";

import { json, readJson, sameOrigin, SESSION_COOKIE } from "@/lib/server/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) {
    return json(
      {
        code: "invalid_origin",
        message: "Open SF Sidekick to save your profile.",
      },
      403,
    );
  }
  if (
    request.headers.get("content-type")?.split(";")[0] !== "application/json"
  ) {
    return json(
      {
        code: "invalid_content_type",
        message: "Invalid request format.",
      },
      415,
    );
  }
  let body: unknown;
  try {
    body = await readJson(request);
  } catch (error) {
    const tooLarge =
      error instanceof Error && error.message === "payload_too_large";
    return json(
      {
        code: tooLarge ? "payload_too_large" : "invalid_json",
        message: "Could not read these details. Review your profile.",
      },
      tooLarge ? 413 : 400,
    );
  }
  const parsed = saveContextSchema.safeParse(body);
  if (!parsed.success)
    return json(
      {
        code: "validation_failed",
        message: "Review the highlighted details.",
        errors: fieldErrors(parsed.error),
      },
      400,
    );
  try {
    await getStore().requireAccount(
      request.cookies.get(SESSION_COOKIE)?.value,
      request.headers.get("x-sidekick-account"),
    );
    const saved = await getStore().save(
      request.cookies.get(SESSION_COOKIE)?.value,
      parsed.data,
    );
    after(async () => {
      try {
        await drainNetworkWork();
      } catch {
        console.error("network_jobs_pending_retry");
      }
    });
    return json(saved);
  } catch (error) {
    if (isStoreError(error, "session_missing"))
      return json(
        {
          code: "session_missing",
          message:
            "Your session changed. Reconnect before saving; your changes are still here.",
        },
        401,
      );
    if (isStoreError(error, "context_conflict"))
      return json(
        {
          code: error.code,
          message:
            "Your profile changed in another tab. Review the saved version to continue.",
        },
        409,
      );
    console.error("context_save_failed");
    return json(
      {
        code: "storage_unavailable",
        message:
          "Could not confirm the save. Your changes are still here; try again.",
      },
      503,
    );
  }
}
