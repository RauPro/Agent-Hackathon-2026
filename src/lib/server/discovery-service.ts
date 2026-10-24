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
type EventRow = { id: string; user_id: string; event_json: string };
export class DiscoveryService {
  constructor(readonly network: NetworkStore) {
    network.db.exec(`
      CREATE TABLE IF NOT EXISTS network_events (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), event_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS network_events_owner ON network_events(user_id);
      CREATE TABLE IF NOT EXISTS network_opportunities (
        id TEXT PRIMARY KEY, user_a TEXT NOT NULL REFERENCES users(id), user_b TEXT NOT NULL REFERENCES users(id),
        signature TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        dismissed_a INTEGER NOT NULL DEFAULT 0, dismissed_b INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_a, user_b), CHECK(user_a < user_b)
      );
    `);
    network.sharedEvents = (ownerId, viewerId) =>
      this.sharedEvents(ownerId, viewerId);
    network.canContactFromOpportunity = (viewerId, targetId) =>
      this.opportunities(viewerId).some((item) => item.userId === targetId);
  }

  events(userId: string): NetworkEvent[] {
    return (
      this.network.db
        .prepare(
          "SELECT * FROM network_events WHERE user_id = ? ORDER BY updated_at DESC",
        )
        .all(userId) as EventRow[]
    ).map(
      (row) => ({ ...JSON.parse(row.event_json), id: row.id }) as NetworkEvent,
    );
  }

  saveEvent(userId: string, input: NetworkEventInput): NetworkEvent {
    const parsed = networkEventSchema.parse(input);
    this.network.profile(userId);
    return this.network.db
      .transaction(() => {
        const existing = parsed.id
          ? this.events(userId).find((event) => event.id === parsed.id)
          : undefined;
        if (parsed.id && !existing) throw new NetworkError("not_found", 404);
        if (!existing && this.events(userId).length >= 30)
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
        this.network.db
          .prepare(
            `INSERT INTO network_events (id,user_id,event_json,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET event_json=excluded.event_json,updated_at=excluded.updated_at`,
          )
          .run(id, userId, JSON.stringify(event), new Date().toISOString());
        this.network.enqueue(userId);
        return event;
      })
      .immediate();
  }

  removeEvent(userId: string, eventId: string) {
    this.network.db
      .transaction(() => {
        this.network.db
          .prepare("DELETE FROM network_events WHERE id=? AND user_id=?")
          .run(eventId, userId);
        this.network.enqueue(userId);
      })
      .immediate();
  }

  sharedEvents(ownerId: string, viewerId: string): SharedEvent[] {
    const connected = this.network.isConnected(ownerId, viewerId);
    if (this.network.blocked(ownerId, viewerId)) return [];
    return this.events(ownerId)
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

  private match(a: string, b: string) {
    if (a === b || this.network.blocked(a, b)) return null;
    const connected = this.network.isConnected(a, b);
    if (
      !connected &&
      (!this.network.settings(a).discoverable ||
        !this.network.settings(b).discoverable)
    )
      return null;
    // Each side receives only the projection the other person authorized them to see.
    const personA = this.network.project(b, a),
      personB = this.network.project(a, b);
    const evidence = rankPeople(
      personA,
      personB,
      Temporal.Now.plainDateISO("America/Los_Angeles").toString(),
      connected,
    );
    return evidence ? { evidence, personA, personB, connected } : null;
  }

  /** Synchronous transactions make queued matching crash-safe without leases or external calls. */
  drain(limit = 20) {
    const jobs = this.network.db
      .prepare(
        "SELECT user_id, version FROM network_jobs ORDER BY updated_at LIMIT ?",
      )
      .all(limit) as { user_id: string; version: number }[];
    for (const job of jobs) {
      this.network.db
        .transaction(() => {
          const users = this.network.db
            .prepare("SELECT id FROM users WHERE id != ?")
            .all(job.user_id) as { id: string }[];
          for (const peer of users) {
            const [a, b] = [job.user_id, peer.id].sort();
            const match = this.match(a, b);
            if (!match) continue; // Reads revalidate current eligibility, so stale records never leak.
            const signature = hash([
              { ...match.personA, revision: undefined },
              { ...match.personB, revision: undefined },
              this.network.relationshipRevision(a, b),
            ]);
            const prior = this.network.db
              .prepare(
                "SELECT * FROM network_opportunities WHERE user_a=? AND user_b=?",
              )
              .get(a, b) as OpportunityRow | undefined;
            const now = new Date().toISOString();
            this.network.db
              .prepare(
                `INSERT INTO network_opportunities (id,user_a,user_b,signature,created_at,updated_at)
            VALUES (?,?,?,?,?,?) ON CONFLICT(user_a,user_b) DO UPDATE SET
            signature=excluded.signature, updated_at=CASE WHEN signature != excluded.signature THEN excluded.updated_at ELSE updated_at END`,
              )
              .run(randomUUID(), a, b, signature, now, now);
            if (
              match.connected &&
              prior?.signature !== signature &&
              !prior?.dismissed_a &&
              !prior?.dismissed_b
            ) {
              // A connection and field visibility authorize this bounded collaboration.
              // No new contact or scheduling action is performed by the worker.
              const sender = match.personB.goal?.type === "hiring" ? b : a;
              const recipient = sender === a ? b : a;
              const digest = hash([a, b, signature]);
              const requestId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
              try {
                this.network.requestInformation(sender, {
                  toUserId: recipient,
                  requestId,
                  fields: ["profile", "goal"],
                  purpose:
                    "Sidekick found a relevant opportunity between your connected profiles. Check the shared professional context.",
                });
              } catch (error) {
                if (
                  !(error instanceof NetworkError) ||
                  error.code !== "rate_limit"
                )
                  throw error;
              }
            }
          }
          this.network.db
            .prepare("DELETE FROM network_jobs WHERE user_id=? AND version=?")
            .run(job.user_id, job.version);
        })
        .immediate();
    }
    return jobs.length;
  }

  opportunities(userId: string): OpportunityView[] {
    const rows = this.network.db
      .prepare("SELECT * FROM network_opportunities WHERE user_a=? OR user_b=?")
      .all(userId, userId) as OpportunityRow[];
    return rows
      .flatMap((row) => {
        const first = row.user_a === userId;
        if (first ? row.dismissed_a : row.dismissed_b) return [];
        const otherId = first ? row.user_b : row.user_a;
        const match = this.match(userId, otherId);
        if (!match) return [];
        return [
          {
            ...match.evidence,
            id: row.id,
            userId: otherId,
            name: match.personB.name,
            createdAt: row.created_at,
            source: networkDemoEnabled()
              ? ("demo" as const)
              : ("user_report" as const),
            connected: match.connected,
          },
        ];
      })
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, 3);
  }

  dismiss(userId: string, id: string) {
    this.network.db
      .prepare(
        `UPDATE network_opportunities SET
      dismissed_a=CASE WHEN user_a=? THEN 1 ELSE dismissed_a END,
      dismissed_b=CASE WHEN user_b=? THEN 1 ELSE dismissed_b END
      WHERE id=? AND (user_a=? OR user_b=?)`,
      )
      .run(userId, userId, id, userId, userId);
  }
}
