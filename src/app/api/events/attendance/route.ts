import { after, NextRequest } from "next/server";
import { eventAttendanceSchema } from "@/lib/domain/discovery";
import { DiscoveryService, registerEventAttendance } from "@/lib/server/discovery-service";
import { json, SESSION_COOKIE } from "@/lib/server/http";
import { networkAccount, networkBody, networkFailure } from "@/lib/server/network-http";
import { drainNetworkWork } from "@/lib/server/network-worker";
import { getStore } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  try {
    const account = await networkAccount(request);
    const store = getStore();
    return json({
      events: await new DiscoveryService(store.network).events(account.id),
      eventVisibility: (await store.network.settings(account.id)).visibility.events,
    });
  } catch (error) {
    return networkFailure(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const account = await networkAccount(request);
    const input = eventAttendanceSchema.parse(await networkBody(request));
    const store = getStore();
    const event = await registerEventAttendance(
      store, request.cookies.get(SESSION_COOKIE)?.value, input,
    );
    after(async () => {
      try {
        await drainNetworkWork();
      } catch {
        console.error("network_jobs_pending_retry");
      }
    });
    return json({
      event,
      eventVisibility: (await store.network.settings(account.id)).visibility.events,
    });
  } catch (error) {
    return networkFailure(error);
  }
}
