import { NextRequest } from "next/server";
import { getStore } from "@/lib/server/store";
import { json, SESSION_COOKIE } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = getStore().ensureSession(
      request.cookies.get(SESSION_COOKIE)?.value,
    );
    const response = json(session.state);
    if (session.created)
      response.cookies.set(SESSION_COOKIE, session.token, {
        httpOnly: true,
        sameSite: "strict",
        secure: request.nextUrl.protocol === "https:",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    return response;
  } catch {
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
