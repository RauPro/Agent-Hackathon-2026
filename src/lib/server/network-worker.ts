import { Temporal } from "@js-temporal/polyfill";
import { DiscoveryService, MATCHING_VERSION } from "./discovery-service";
import { getStore } from "./store";
import type { NetworkStore } from "./network-store";
import { AgentDialogueService } from "./agent-dialogue-service";

const globalNetwork = globalThis as typeof globalThis & {
  sidekickNetworkTimer?: ReturnType<typeof setInterval>;
};

export async function enqueueDailyNetworkWork(network: NetworkStore) {
  const day = Temporal.Now.plainDateISO("America/Los_Angeles").toString();
  const sweep = `${day}:v${MATCHING_VERSION}`;
  return network.db
    .transaction(async () => {
      const prior = (await network.db
        .prepare("SELECT value FROM app_meta WHERE key = ?")
        .get("network-discovery-day")) as { value: string } | undefined;
      if (prior?.value === sweep) return false;
      const matcherChanged = !!prior && !prior.value.endsWith(`:v${MATCHING_VERSION}`);
      // The day and jobs commit together. Cold starts do not enqueue the whole network again.
      // Only a new matcher resets pending cursors; ordinary daily checks preserve progress.
      await network.db
        .prepare(
          `INSERT INTO network_jobs (user_id, version, updated_at, cursor, priority)
      SELECT id, 1, ?, '', 0 FROM users WHERE 1
      ON CONFLICT(user_id) DO UPDATE SET
        version = network_jobs.version + ?,
        cursor = CASE WHEN ? THEN '' ELSE network_jobs.cursor END,
        updated_at = CASE WHEN ? THEN excluded.updated_at ELSE network_jobs.updated_at END`,
        )
        .run(new Date().toISOString(), Number(matcherChanged), Number(matcherChanged), Number(matcherChanged));
      await network.db
        .prepare(
          `INSERT INTO app_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run("network-discovery-day", sweep);
      return true;
    })
    .immediate();
}

export async function drainNetworkWork(network = getStore().network) {
  await enqueueDailyNetworkWork(network);
  const comparisons = await new DiscoveryService(network).drain();
  // Two bounded model turns fit alongside discovery inside the function budget.
  // The persisted pair state and leases resume the conversation on later ticks.
  const turns = await new AgentDialogueService(network).drain(2);
  return comparisons + turns;
}

export function startNetworkWorker() {
  // Serverless work runs through authenticated cron or Next.js after(), not an unowned timer.
  if (process.env.VERCEL === "1" || globalNetwork.sidekickNetworkTimer) return;
  const tick = async () => {
    try {
      await drainNetworkWork();
    } catch {
      console.error("network_jobs_pending_retry");
    }
  };
  void tick();
  globalNetwork.sidekickNetworkTimer = setInterval(() => void tick(), 30_000);
  globalNetwork.sidekickNetworkTimer.unref();
}
