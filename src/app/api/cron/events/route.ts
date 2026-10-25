import { timingSafeEqual } from "node:crypto";
import { json } from "@/lib/server/http";
import { drainEventDiscovery } from "@/lib/server/event-discovery-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(secret ? `Bearer ${secret}` : "");
  if (!secret || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
    return json({ message: "Unauthorized." }, 401);
  try {
    return json(await drainEventDiscovery());
  } catch {
    console.error("event_cron_failed");
    return json({ message: "Event discovery remains pending. Retry later." }, 503);
  }
}
