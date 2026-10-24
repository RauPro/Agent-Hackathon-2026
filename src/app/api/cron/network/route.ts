import { timingSafeEqual } from "node:crypto";
import { json } from "@/lib/server/http";
import { drainNetworkWork } from "@/lib/server/network-worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(secret ? `Bearer ${secret}` : "");
  if (
    !secret ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return json({ message: "Unauthorized." }, 401);
  try {
    const processed = await drainNetworkWork();
    return json({ processed });
  } catch {
    console.error("network_cron_failed");
    return json({ message: "Queued work remains pending. Retry later." }, 503);
  }
}
