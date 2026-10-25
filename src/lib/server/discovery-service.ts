import { createHash, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import {
  networkEventSchema,
  eventAttendanceSchema,
  canonicalEventDate,
  canonicalEventUrl,
  rankPeople,
  type EventAttendanceInput,
  type NetworkEvent,
  type NetworkEventInput,
  type OpportunityView,
} from "../domain/discovery";
import type { SharedEvent } from "../domain/network";
import { eventHasEnded, type DiscoveryResult } from "../domain/event-discovery";
import type { ContextStore } from "./store";
import { NetworkError, NetworkStore } from "./network-store";
import { networkDemoEnabled } from "./demo-mode";
import { AgentDialogueService } from "./agent-dialogue-service";
// Bump when eligibility rules change so the worker revisits cached no-match results.
export const MATCHING_VERSION = 2;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function eventKey(event: Pick<NetworkEvent, "url" | "date" | "dateStatus" | "start">) {
  return event.url
    ? hash([canonicalEventUrl(event.url), canonicalEventDate(event) ?? event.date ?? null,
        event.dateStatus ?? "confirmed"])
    : undefined;
}

function eventKeys(event: Pick<NetworkEvent, "url" | "aliasUrls" | "date" | "dateStatus" | "start">) {
  return [...new Set([event.url, ...(event.aliasUrls ?? [])]
    .filter((url): url is string => !!url)
    .map((url) => eventKey({ ...event, url })!))].sort();
}

function normalizedEvent(row: EventRow): NetworkEvent {
  const event = JSON.parse(row.event_json) as NetworkEvent;
  const date = canonicalEventDate(event);
  return {
    ...event,
    id: row.id,
    attendance: event.attendance ?? "planned",
    ...(date && { date, dateStatus: event.dateStatus ?? "confirmed" }),
    canonicalKey: eventKey(event),
    canonicalKeys: eventKeys(event),
  };
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

/** An explicit user report, resolved from that account's current discovery snapshot. */
export async function registerEventAttendance(
  store: ContextStore,
  token: string | undefined,
  input: EventAttendanceInput,
  now = new Date(),
): Promise<NetworkEvent> {
  const parsed = eventAttendanceSchema.parse(input);
  const service = new DiscoveryService(store.network);
  return store.db.transaction(async () => {
    const account = await store.requireAccount(token);
    const profile = await store.read(token);
    if (!profile?.context || !profile.confirmedAt)
      throw new NetworkError("profile_missing", 400, "Confirm your profile before saving a registration.");
    if (profile.revision !== parsed.revision)
      throw new NetworkError("stale_revision", 409, "Your profile changed. Reload your event suggestions.");
    const snapshot = await store.readDiscovery(token, now);
    if (!snapshot || snapshot.profile_revision !== parsed.revision ||
      !["ready", "partial"].includes(snapshot.status) || !snapshot.result_json)
      throw new NetworkError("stale_recommendation", 409, "Reload your current event suggestions before saving a registration.");
    const result = JSON.parse(snapshot.result_json) as DiscoveryResult;
    if (result.checkedAt !== parsed.discoveryCheckedAt)
      throw new NetworkError("stale_recommendation", 409, "Your suggestions changed. Review the latest event before saving a registration.");
    const recommendation = result.recommendations.find((event) => event.id === parsed.recommendationId);
    if (!recommendation)
      throw new NetworkError("not_found", 404, "This event is not in your current suggestions.");
    if (recommendation.dateStatus === "confirmed" && eventHasEnded(recommendation, now))
      throw new NetworkError("event_past", 409, "This event has ended. Refresh your event suggestions.");
    const instant = (time: string | null) => {
      if (!time || recommendation.dateStatus !== "confirmed" || !recommendation.timeZoneStated) return null;
      try {
        return Temporal.ZonedDateTime.from(
          `${recommendation.date}T${time}[America/Los_Angeles]`,
          { disambiguation: "reject" },
        ).toInstant().toString();
      } catch {
        return null;
      }
    };
    const draft = {
      url: canonicalEventUrl(recommendation.url),
      aliasUrls: [...new Set(recommendation.alsoListed.map((source) => canonicalEventUrl(source.url)))]
        .filter((url) => url !== canonicalEventUrl(recommendation.url)).sort(),
      date: recommendation.date,
      dateStatus: recommendation.dateStatus,
      start: instant(recommendation.startTime),
    };
    const canonicalKey = eventKey(draft)!;
    const keys = eventKeys(draft);
    const events = await service.events(account.id);
    const existing = events.find((event) => event.canonicalKeys?.some((key) => keys.includes(key)));
    // Retain previously established aliases when a later source lists fewer links.
    draft.aliasUrls = [...new Set([...draft.aliasUrls, ...(existing?.aliasUrls ?? []), existing?.url]
      .filter((url): url is string => !!url).map(canonicalEventUrl))]
      .filter((url) => url !== draft.url).sort();
    if (!existing && events.length >= 30)
      throw new NetworkError("event_limit", 400, "Remove an old event before adding another.");
    const event: NetworkEvent = {
      ...draft,
      id: existing?.id ?? randomUUID(),
      title: recommendation.title,
      end: instant(recommendation.endTime),
      area: recommendation.location.city,
      attendance: "registered",
      reportedAt: existing?.attendance === "registered" && existing.reportedAt
        ? existing.reportedAt : now.toISOString(),
      sourceRecommendationId: recommendation.id,
      sourceCheckedAt: result.checkedAt,
      canonicalKey,
      canonicalKeys: eventKeys(draft),
      sourceMode: networkDemoEnabled() ? "demo" : "user_report",
      visibility: parsed.visibility,
    };
    // A retry preserves its original report and causes no new matching trigger.
    if (existing && Object.entries(event).every(([key, value]) =>
      JSON.stringify(existing[key as keyof NetworkEvent]) === JSON.stringify(value))) return existing;
    await store.db.prepare(`INSERT INTO network_events (id,user_id,event_json,updated_at)
      VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      event_json=excluded.event_json,updated_at=excluded.updated_at`)
      .run(event.id, account.id, JSON.stringify(event), now.toISOString());
    await store.network.enqueue(account.id);
    return event;
  }).immediate();
}

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
    ).map(normalizedEvent);
  }
  async saveEvent(
    userId: string,
    input: NetworkEventInput,
  ): Promise<NetworkEvent> {
    const parsed = networkEventSchema.parse(input);
    await this.network.profile(userId);
    return this.network.db
      .transaction(async () => {
        const events = await this.events(userId);
        const key = eventKey(parsed);
        const existing = parsed.id
          ? events.find((event) => event.id === parsed.id)
          : key ? events.find((event) => event.canonicalKeys?.includes(key)) : undefined;
        if (parsed.id && !existing) throw new NetworkError("not_found", 404);
        if (!existing && events.length >= 30)
          throw new NetworkError(
            "event_limit",
            400,
            "Remove an old event before adding another.",
          );
        const id = existing?.id ?? randomUUID();
        const sameEvent = key ? existing?.canonicalKeys?.includes(key) : existing?.canonicalKey === key;
        const attendance = parsed.attendance ?? (sameEvent ? existing?.attendance : undefined) ?? "planned";
        const event: NetworkEvent = {
          ...existing,
          ...parsed,
          id,
          date: canonicalEventDate(parsed)!,
          dateStatus: "confirmed",
          attendance,
          canonicalKey: key,
          aliasUrls: sameEvent
            ? [...new Set([...(existing?.aliasUrls ?? []), existing?.url]
                .filter((url): url is string => !!url).map(canonicalEventUrl))]
                .filter((url) => !parsed.url || url !== canonicalEventUrl(parsed.url)).sort()
            : undefined,
          canonicalKeys: sameEvent ? existing?.canonicalKeys : key ? [key] : [],
          sourceRecommendationId: sameEvent ? existing?.sourceRecommendationId : undefined,
          sourceCheckedAt: sameEvent ? existing?.sourceCheckedAt : undefined,
          reportedAt: sameEvent && existing?.attendance === attendance && existing.reportedAt
            ? existing.reportedAt : new Date().toISOString(),
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
    if (!(await this.network.canSee(viewerId, ownerId, "events"))) return [];
    return (await this.events(ownerId))
      .filter(
        (event) =>
          event.visibility === "network" ||
          (connected && event.visibility === "friends") ||
          ownerId === viewerId,
      )
      .map(({ id, title, start, end, date, dateStatus, attendance, reportedAt, area, sourceMode, canonicalKey, canonicalKeys }) => ({
        // The provider identity and SF date survive differing or unknown event times.
        id: canonicalKey ?? id,
        canonicalKeys,
        title,
        start,
        end,
        date,
        dateStatus,
        attendance,
        reportedAt,
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

  private async processChangedPair(ownerId: string, peerId: string) {
    const [a, b] = [ownerId, peerId].sort();
    const db = this.network.db;
    // A negative result needs the same deduplication as a positive opportunity.
    // Hash source revisions/data, never store another copy of private context.
    const inputs = await db.prepare(`
      SELECT u.id, s.revision, ns.settings_json,
        (SELECT group_concat(event_json) FROM
          (SELECT event_json FROM network_events WHERE user_id = u.id ORDER BY id)) AS events
      FROM users u JOIN sessions s ON s.token_hash = u.profile_id
      LEFT JOIN network_settings ns ON ns.user_id = u.id
      WHERE u.id IN (?, ?) ORDER BY u.id`).all(a, b);
    const fingerprint = hash([
      MATCHING_VERSION,
      Temporal.Now.plainDateISO("America/Los_Angeles").toString(), inputs,
      await this.network.relationshipRevision(a, b),
    ]);
    const previous = await db.prepare(
      "SELECT fingerprint FROM network_pair_checks WHERE user_a = ? AND user_b = ?",
    ).get(a, b);
    if (previous?.fingerprint === fingerprint) return;
    await this.processPair(a, b);
    await db.prepare(`INSERT INTO network_pair_checks (user_a, user_b, fingerprint, checked_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(user_a, user_b) DO UPDATE SET
      fingerprint = excluded.fingerprint, checked_at = excluded.checked_at`)
      .run(a, b, fingerprint, new Date().toISOString());
  }

  /** Resume bounded work fairly; a fresh profile need not wait for the daily sweep. */
  async drain(limit = 80): Promise<number> {
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
        processed < Math.max(1, Math.min(limit, 80)) &&
        Date.now() < deadline
      ) {
        const job = (await db
          .prepare(
            "SELECT user_id, version, cursor FROM network_jobs ORDER BY priority DESC, updated_at, user_id LIMIT 1",
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
            if (peers[0]) await this.processChangedPair(job.user_id, peers[0].id);
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
                  new Date(Date.now() + processed + 1).toISOString(),
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

  async matchingStatus(userId: string): Promise<{ pending: boolean; lastCheckedAt: string | null }> {
    const row = await this.network.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM network_jobs WHERE user_id = ?) AS pending,
      (SELECT MAX(checked_at) FROM network_pair_checks WHERE user_a = ? OR user_b = ?) AS checked_at`)
      .get(userId, userId, userId);
    return { pending: !!row?.pending, lastCheckedAt: row?.checked_at as string | null ?? null };
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
