import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import {
  networkEventSchema,
  rankPeople,
  type NetworkEvent,
  type NetworkEventInput,
  type OpportunityView,
} from "../domain/discovery";
import type { SharedEvent } from "../domain/network";
import { NetworkError, NetworkStore } from "./network-store";
import { networkDemoEnabled } from "./demo-mode";
import { AgentDialogueService } from "./agent-dialogue-service";
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function canonicalEventUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ["fbclid", "gclid"].includes(key))
      url.searchParams.delete(key);
  }
  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}
type OpportunityRow = {
  id: string;
  user_a: string;
  user_b: string;
  signature: string;
  created_at: string;
  dismissed_a: number;
  dismissed_b: number;
};
type EventRow = {
  id: string;
  user_id: string;
  event_json: string;
};
// Filter only eligibility in SQL; each match still rechecks field-level visibility.
const eligiblePeopleSql = `SELECT u.id,
  COALESCE(json_extract(ns.settings_json, '$.discoverable'), 0) AS discoverable
  FROM users u JOIN sessions s ON s.token_hash = u.profile_id
  LEFT JOIN network_settings ns ON ns.user_id = u.id
  WHERE s.context_json IS NOT NULL AND s.confirmed_at IS NOT NULL`;
const eligibleRelationshipSql = `NOT EXISTS(SELECT 1 FROM network_blocks WHERE
    (user_id = owner.id AND blocked_user_id = peer.id) OR
    (user_id = peer.id AND blocked_user_id = owner.id))
  AND ((owner.discoverable = 1 AND peer.discoverable = 1)
    OR EXISTS(SELECT 1 FROM network_connections WHERE status = 'accepted'
      AND user_a = min(owner.id, peer.id) AND user_b = max(owner.id, peer.id)))`;

export class DiscoveryService {
  constructor(readonly network: NetworkStore) {
    network.sharedEvents = async (ownerId, viewerId) =>
      await this.sharedEvents(ownerId, viewerId);
    network.canContactFromOpportunity = async (viewerId, targetId) =>
      (await this.opportunities(viewerId)).some(
        (item) => item.userId === targetId,
      );
  }
  async events(userId: string): Promise<NetworkEvent[]> {
    return (
      (await this.network.db
        .prepare(
          "SELECT * FROM network_events WHERE user_id = ? ORDER BY updated_at DESC",
        )
        .all(userId)) as EventRow[]
    ).map(
      (row) => ({ ...JSON.parse(row.event_json), id: row.id }) as NetworkEvent,
    );
  }
  async saveEvent(
    userId: string,
    input: NetworkEventInput,
  ): Promise<NetworkEvent> {
    const parsed = networkEventSchema.parse(input);
    await this.network.profile(userId);
    return this.network.db
      .transaction(async () => {
        const existing = parsed.id
          ? (await this.events(userId)).find((event) => event.id === parsed.id)
          : undefined;
        if (parsed.id && !existing) throw new NetworkError("not_found", 404);
        if (!existing && (await this.events(userId)).length >= 30)
          throw new NetworkError(
            "event_limit",
            400,
            "Remove an old event before adding another.",
          );
        const id = parsed.id ?? randomUUID();
        const event: NetworkEvent = {
          ...parsed,
          id,
          sourceMode: networkDemoEnabled() ? "demo" : "user_report",
        };
        await this.network.db
          .prepare(
            `INSERT INTO network_events (id,user_id,event_json,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET event_json=excluded.event_json,updated_at=excluded.updated_at`,
          )
          .run(id, userId, JSON.stringify(event), new Date().toISOString());
        await this.network.enqueue(userId);
        return event;
      })
      .immediate();
  }
  async removeEvent(userId: string, eventId: string) {
    return this.network.db
      .transaction(async () => {
        await this.network.db
          .prepare("DELETE FROM network_events WHERE id=? AND user_id=?")
          .run(eventId, userId);
        await this.network.enqueue(userId);
      })
      .immediate();
  }
  async sharedEvents(
    ownerId: string,
    viewerId: string,
  ): Promise<SharedEvent[]> {
    const connected = await this.network.isConnected(ownerId, viewerId);
    if (await this.network.blocked(ownerId, viewerId)) return [];
    return (await this.events(ownerId))
      .filter(
        (event) =>
          event.visibility === "network" ||
          (connected && event.visibility === "friends") ||
          ownerId === viewerId,
      )
      .map(({ id, title, start, end, area, sourceMode, url }) => ({
        // A shared public link and identical times identify the same reported event.
        id: url
          ? hash([canonicalEventUrl(url), Date.parse(start), Date.parse(end)])
          : id,
        title,
        start,
        end,
        area,
        sourceMode,
      }));
  }
  private async match(a: string, b: string) {
    if (a === b || (await this.network.blocked(a, b))) return null;
    const connected = await this.network.isConnected(a, b);
    if (
      !connected &&
      (!(await this.network.settings(a)).discoverable ||
        !(await this.network.settings(b)).discoverable)
    )
      return null;
    // Each side receives only the projection the other person authorized them to see.
    const personA = await this.network.project(b, a),
      personB = await this.network.project(a, b);
    const evidence = rankPeople(
      personA,
      personB,
      Temporal.Now.plainDateISO("America/Los_Angeles").toString(),
      connected,
    );
    return evidence ? { evidence, personA, personB, connected } : null;
  }
  private async processPair(ownerId: string, peerId: string) {
    const [a, b] = [ownerId, peerId].sort();
    // Conversation belongs to accepted connections, independently of ranking.
    // Discovery before acceptance produces proposals only.
    if (await this.network.isConnected(a, b))
      await new AgentDialogueService(this.network).syncPair(a, b);
    const match = await this.match(a, b);
    if (!match) return; // Reads revalidate current eligibility, so stale records never leak.
    const signature = hash([
      { ...match.personA, revision: undefined },
      { ...match.personB, revision: undefined },
      await this.network.relationshipRevision(a, b),
    ]);
    const now = new Date().toISOString();
    await this.network.db
      .prepare(
        `INSERT INTO network_opportunities (id,user_a,user_b,signature,created_at,updated_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(user_a,user_b) DO UPDATE SET
            signature=excluded.signature, updated_at=CASE WHEN signature != excluded.signature THEN excluded.updated_at ELSE updated_at END`,
      )
      .run(randomUUID(), a, b, signature, now, now);
  }

  /** Resume a few peer comparisons per invocation. Only one pair occupies a transaction. */
  async drain(limit = 5): Promise<number> {
    const db = this.network.db;
    const leaseKey = "network-discovery";
    const lease = await db.acquireLease(leaseKey, 45_000);
    if (!lease) return 0;
    const deadline = Date.now() + 20_000;
    let processed = 0;
    try {
      // Remove obsolete triggers together instead of spending a batch on inactive accounts.
      // A newly confirmed profile, opt-in, or accepted connection enqueues a fresh version.
      await db
        .prepare(
          `WITH eligible AS (${eligiblePeopleSql})
        DELETE FROM network_jobs WHERE NOT EXISTS(
          SELECT 1 FROM eligible owner JOIN eligible peer ON peer.id != owner.id
          WHERE owner.id = network_jobs.user_id AND ${eligibleRelationshipSql})`,
        )
        .run();
      while (
        processed < Math.max(1, Math.min(limit, 5)) &&
        Date.now() < deadline
      ) {
        const job = (await db
          .prepare(
            "SELECT user_id, version, cursor FROM network_jobs ORDER BY updated_at, user_id LIMIT 1",
          )
          .get()) as
          | { user_id: string; version: number; cursor: string }
          | undefined;
        if (!job) break;
        const advanced = await db
          .transaction(async () => {
            const owned = await db
              .prepare(
                "SELECT 1 FROM database_leases WHERE key = ? AND token = ? AND expires_at > ?",
              )
              .get(leaseKey, lease, Date.now());
            if (!owned) return false;
            const current = await db
              .prepare(
                "SELECT 1 FROM network_jobs WHERE user_id = ? AND version = ? AND cursor = ?",
              )
              .get(job.user_id, job.version, job.cursor);
            if (!current) return false;
            const peers = (await db
              .prepare(
                `WITH eligible AS (${eligiblePeopleSql})
                  SELECT peer.id FROM eligible owner JOIN eligible peer ON peer.id != owner.id
                  WHERE owner.id = ? AND peer.id > ? AND ${eligibleRelationshipSql}
                  ORDER BY peer.id LIMIT 2`,
              )
              .all(job.user_id, job.cursor)) as { id: string }[];
            if (peers[0]) await this.processPair(job.user_id, peers[0].id);
            if (peers.length < 2) {
              await db
                .prepare(
                  "DELETE FROM network_jobs WHERE user_id = ? AND version = ? AND cursor = ?",
                )
                .run(job.user_id, job.version, job.cursor);
            } else {
              await db
                .prepare(
                  "UPDATE network_jobs SET cursor = ?, updated_at = ? WHERE user_id = ? AND version = ? AND cursor = ?",
                )
                .run(
                  peers[0].id,
                  new Date().toISOString(),
                  job.user_id,
                  job.version,
                  job.cursor,
                );
            }
            return true;
          })
          .immediate();
        if (!advanced) break;
        processed += 1;
      }
      return processed;
    } finally {
      await db.releaseLease(leaseKey, lease);
    }
  }

  async opportunities(userId: string): Promise<OpportunityView[]> {
    const rows = (await this.network.db
      .prepare("SELECT * FROM network_opportunities WHERE user_a=? OR user_b=?")
      .all(userId, userId)) as OpportunityRow[];
    const result: OpportunityView[] = [];
    for (const row of rows) {
      const first = row.user_a === userId;
      if (first ? row.dismissed_a : row.dismissed_b) continue;
      const otherId = first ? row.user_b : row.user_a;
      const match = await this.match(userId, otherId);
      if (!match) continue;
      result.push({
        ...match.evidence,
        id: row.id,
        userId: otherId,
        name: match.personB.name,
        goal: match.personB.goal,
        createdAt: row.created_at,
        source: networkDemoEnabled() ? "demo" : "user_report",
        connected: match.connected,
      });
    }
    return result
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 3);
  }

  async dismiss(userId: string, id: string) {
    await this.network.db
      .prepare(
        `UPDATE network_opportunities SET
      dismissed_a=CASE WHEN user_a=? THEN 1 ELSE dismissed_a END,
      dismissed_b=CASE WHEN user_b=? THEN 1 ELSE dismissed_b END
      WHERE id=? AND (user_a=? OR user_b=?)`,
      )
      .run(userId, userId, id, userId, userId);
  }
}
