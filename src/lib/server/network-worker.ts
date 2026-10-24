import { Temporal } from "@js-temporal/polyfill";
import { DiscoveryService } from "./discovery-service";
import { getStore } from "./store";

const globalNetwork = globalThis as typeof globalThis & {
  sidekickNetworkTimer?: ReturnType<typeof setInterval>;
  sidekickNetworkDay?: string;
};
export function drainNetworkWork() {
  const network = getStore().network;
  const discovery = new DiscoveryService(network);
  const day = Temporal.Now.plainDateISO("America/Los_Angeles").toString();
  if (globalNetwork.sidekickNetworkDay !== day) {
    // Reevaluate date-sensitive opportunities once per SF day, including after restart.
    for (const user of network.db.prepare("SELECT id FROM users").all() as {
      id: string;
    }[])
      network.enqueue(user.id);
    globalNetwork.sidekickNetworkDay = day;
  }
  return discovery.drain();
}
export function startNetworkWorker() {
  if (globalNetwork.sidekickNetworkTimer) return;
  const tick = () => {
    try {
      drainNetworkWork();
    } catch {
      console.error("network_jobs_pending_retry");
    }
  };
  tick();
  globalNetwork.sidekickNetworkTimer = setInterval(tick, 30_000);
  globalNetwork.sidekickNetworkTimer.unref();
}
