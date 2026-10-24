import { NextRequest } from "next/server";
import { MeetingService } from "@/lib/server/meeting-service";
import { getStore } from "@/lib/server/store";
import { networkAccount, networkFailure } from "@/lib/server/network-http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const account = networkAccount(request),
      { id } = await context.params;
    const calendar = new MeetingService(getStore()).exportICS(account.id, id);
    return new Response(calendar, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="sidekick-meeting.ics"',
        "Cache-Control": "private, no-store",
        Vary: "Cookie",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return networkFailure(error);
  }
}
