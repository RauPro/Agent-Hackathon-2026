import { isStoreError, getStore } from "@/lib/server/store";

import { NextRequest } from "next/server";

import { json, SESSION_COOKIE } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    await getStore().requireAccount(
      token,
      request.headers.get("x-sidekick-account"),
    );
    return json(await getStore().read(token));
  } catch (error) {
    if (isStoreError(error, "session_missing"))
      return json(
        { code: "session_missing", message: "Sign in to open your profile." },
        401,
      );
    console.error("state_read_failed");
    return json(
      {
        code: "storage_unavailable",
        message: "Could not open your profile. Try again.",
      },
      503,
    );
  }
}
