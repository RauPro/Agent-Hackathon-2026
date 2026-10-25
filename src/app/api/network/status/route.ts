import { NextRequest } from "next/server";
import { getStore } from "@/lib/server/store";
import { DiscoveryService } from "@/lib/server/discovery-service";
import { networkAccount, networkFailure } from "@/lib/server/network-http";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const account = await networkAccount(request), store = getStore();
    const discovery = new DiscoveryService(store.network);
    return json({
      accountId: account.id,
      settings: await store.network.settings(account.id),
      matching: await discovery.matchingStatus(account.id),
      opportunities: (await discovery.opportunities(account.id)).filter((person) => !person.connected)
        .map(({ id, name }) => ({ id, name })),
    });
  } catch (error) { return networkFailure(error); }
}
