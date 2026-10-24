import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { contextSchema, type ContextState } from "../domain/context";
import {
  connectionRequestSchema,
  informationAnswerSchema,
  informationRequestSchema,
  networkSettingsSchema,
  type AgentMessage,
  type ConnectionAction,
  type ConnectionRequest,
  type ConnectionView,
  type InformationAnswer,
  type InformationRequest,
  type NetworkField,
  type NetworkSettings,
  type NetworkSettingsInput,
  type SharedEvent,
  type SharedProfile,
} from "../domain/network";

export class NetworkError extends Error {
  readonly kind = "network_error";
  constructor(
    public code: string,
    public status = 400,
    message = "This network action is not available.",
  ) {
    super(message);
  }
}

type ConnectionRow = {
  user_a: string;
  user_b: string;
  requester_id: string;
  status: "pending" | "accepted" | "removed";
  context: string;
  source: "qr" | "opportunity";
  created_at: string;
  updated_at: string;
};
type MessageRow = {
  id: string;
  from_user_id: string;
  to_user_id: string;
  request_key: string;
  payload_hash: string;
  message_json: string;
  answers_json: string;
  answer_revision: number | null;
};
const timestamp = () => new Date().toISOString();
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const pair = (a: string, b: string) => [a, b].sort() as [string, string];

// Uses the existing database and stable account IDs. Callers authenticate the user
// before invoking these methods; no method accepts a model-provided sender identity.
export class NetworkStore {
  canContactFromOpportunity?: (viewerId: string, targetId: string) => boolean;
  sharedEvents?: (ownerId: string, viewerId: string) => SharedEvent[];

  constructor(readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS network_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        settings_json TEXT NOT NULL,
        qr_token TEXT UNIQUE NOT NULL
      );
      CREATE TABLE IF NOT EXISTS network_connections (
        user_a TEXT NOT NULL REFERENCES users(id), user_b TEXT NOT NULL REFERENCES users(id),
        requester_id TEXT NOT NULL REFERENCES users(id),
        status TEXT NOT NULL, context TEXT NOT NULL, source TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_a, user_b), CHECK(user_a < user_b)
      );
      CREATE TABLE IF NOT EXISTS network_blocks (
        user_id TEXT NOT NULL REFERENCES users(id), blocked_user_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, PRIMARY KEY(user_id, blocked_user_id), CHECK(user_id != blocked_user_id)
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY, from_user_id TEXT NOT NULL REFERENCES users(id),
        to_user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL, message_json TEXT NOT NULL,
        answers_json TEXT NOT NULL DEFAULT '{}', answer_revision INTEGER,
        created_at TEXT NOT NULL, UNIQUE(from_user_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS agent_messages_recipient ON agent_messages(to_user_id, created_at);
      CREATE TABLE IF NOT EXISTS network_jobs (
        user_id TEXT PRIMARY KEY REFERENCES users(id), version INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private requireUser(userId: string) {
    if (!this.db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId))
      throw new NetworkError("not_found", 404);
  }

  profile(userId: string): ContextState {
    const row = this.db
      .prepare(
        `SELECT s.context_json, s.revision, s.confirmed_at
      FROM users u JOIN sessions s ON s.token_hash = u.profile_id WHERE u.id = ?`,
      )
      .get(userId) as
      | {
          context_json: string | null;
          revision: number;
          confirmed_at: string | null;
        }
      | undefined;
    if (!row) throw new NetworkError("not_found", 404);
    return {
      context: row.context_json
        ? contextSchema.parse(JSON.parse(row.context_json))
        : null,
      revision: row.revision,
      confirmedAt: row.confirmed_at,
      evidenceKind: row.context_json ? "user_report" : null,
    };
  }

  private name(userId: string) {
    return this.profile(userId).context?.profile.name ?? "Sidekick member";
  }

  settings(userId: string): NetworkSettings {
    this.requireUser(userId);
    const existing = this.db
      .prepare(
        "SELECT settings_json, qr_token FROM network_settings WHERE user_id = ?",
      )
      .get(userId) as { settings_json: string; qr_token: string } | undefined;
    if (existing)
      return {
        ...networkSettingsSchema.parse(JSON.parse(existing.settings_json)),
        qrToken: existing.qr_token,
      };
    const input: NetworkSettingsInput = {
      discoverable: false,
      visibility: {
        profile: "private",
        goal: "private",
        trip: "private",
        events: "private",
      },
      area: null,
      revision: 0,
    };
    const qrToken = randomBytes(32).toString("base64url");
    this.db
      .prepare(
        "INSERT OR IGNORE INTO network_settings (user_id, settings_json, qr_token) VALUES (?, ?, ?)",
      )
      .run(userId, JSON.stringify(input), qrToken);
    return this.settings(userId);
  }

  saveSettings(userId: string, input: NetworkSettingsInput): NetworkSettings {
    const parsed = networkSettingsSchema.parse(input);
    return this.db
      .transaction(() => {
        const current = this.settings(userId);
        if (current.revision !== parsed.revision)
          throw new NetworkError(
            "stale_revision",
            409,
            "Your sharing settings changed. Reload and try again.",
          );
        const next = {
          ...parsed,
          area: parsed.area || null,
          revision: current.revision + 1,
        };
        this.db
          .prepare(
            "UPDATE network_settings SET settings_json = ? WHERE user_id = ?",
          )
          .run(JSON.stringify(next), userId);
        this.enqueue(userId);
        return { ...next, qrToken: current.qrToken };
      })
      .immediate();
  }

  rotateQr(userId: string): NetworkSettings {
    this.settings(userId);
    this.db
      .prepare("UPDATE network_settings SET qr_token = ? WHERE user_id = ?")
      .run(randomBytes(32).toString("base64url"), userId);
    return this.settings(userId);
  }

  resolveQr(viewerId: string, token: string): { id: string; name: string } {
    this.requireUser(viewerId);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new NetworkError("not_found", 404);
    const row = this.db
      .prepare("SELECT user_id FROM network_settings WHERE qr_token = ?")
      .get(token) as { user_id: string } | undefined;
    if (!row || row.user_id === viewerId || this.blocked(viewerId, row.user_id))
      throw new NetworkError("not_found", 404);
    return { id: row.user_id, name: this.name(row.user_id) };
  }

  blocked(a: string, b: string): boolean {
    return !!this.db
      .prepare(
        `SELECT 1 FROM network_blocks WHERE
      (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)`,
      )
      .get(a, b, b, a);
  }

  private connection(a: string, b: string) {
    return this.db
      .prepare(
        "SELECT * FROM network_connections WHERE user_a = ? AND user_b = ?",
      )
      .get(...pair(a, b)) as ConnectionRow | undefined;
  }

  isConnected(a: string, b: string): boolean {
    return (
      a !== b &&
      !this.blocked(a, b) &&
      this.connection(a, b)?.status === "accepted"
    );
  }

  private connectionView(userId: string, row: ConnectionRow): ConnectionView {
    const peer = row.user_a === userId ? row.user_b : row.user_a;
    return {
      userId: peer,
      name: this.name(peer),
      status: this.blocked(userId, peer) ? "blocked" : row.status,
      direction: row.requester_id === userId ? "outgoing" : "incoming",
      context: row.context,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  connections(userId: string): ConnectionView[] {
    this.requireUser(userId);
    const rows = this.db
      .prepare(
        `SELECT * FROM network_connections WHERE user_a = ? OR user_b = ? ORDER BY updated_at DESC`,
      )
      .all(userId, userId) as ConnectionRow[];
    return rows
      .filter(
        (row) =>
          row.status !== "removed" || this.blocked(row.user_a, row.user_b),
      )
      .map((row) => this.connectionView(userId, row));
  }

  requestConnection(
    userId: string,
    targetId: string,
    input: ConnectionRequest,
  ): ConnectionView {
    const parsed = connectionRequestSchema.parse(input);
    this.requireUser(userId);
    this.requireUser(targetId);
    return this.db
      .transaction(() => {
        if (userId === targetId || this.blocked(userId, targetId))
          throw new NetworkError("not_available", 403);
        if (parsed.source === "qr") {
          if (
            !parsed.token ||
            this.resolveQr(userId, parsed.token).id !== targetId
          )
            throw new NetworkError("not_available", 403);
        } else if (!this.canContactFromOpportunity?.(userId, targetId))
          throw new NetworkError("not_available", 403);
        const current = this.connection(userId, targetId);
        if (current && current.status !== "removed")
          return this.connectionView(userId, current);
        const count = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM network_connections WHERE requester_id = ? AND updated_at > ?",
          )
          .get(userId, new Date(Date.now() - 86400000).toISOString()) as {
          n: number;
        };
        if (count.n >= 30)
          throw new NetworkError(
            "rate_limit",
            429,
            "Try new connections tomorrow.",
          );
        const [a, b] = pair(userId, targetId),
          now = timestamp();
        this.db
          .prepare(
            `INSERT INTO network_connections (user_a, user_b, requester_id, status, context, source, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT(user_a, user_b) DO UPDATE SET
        requester_id = excluded.requester_id, status = 'pending', context = excluded.context, source = excluded.source,
        created_at = excluded.created_at, updated_at = excluded.updated_at`,
          )
          .run(a, b, userId, parsed.context, parsed.source, now, now);
        return this.connectionView(userId, this.connection(userId, targetId)!);
      })
      .immediate();
  }

  connectionAction(
    userId: string,
    targetId: string,
    action: ConnectionAction,
  ): ConnectionView | null {
    this.requireUser(userId);
    this.requireUser(targetId);
    if (!["accept", "decline", "remove", "block", "unblock"].includes(action))
      throw new NetworkError("invalid_action");
    if (userId === targetId) throw new NetworkError("not_available", 403);
    return this.db
      .transaction(() => {
        const current = this.connection(userId, targetId),
          now = timestamp();
        if (action === "block") {
          this.db
            .prepare(
              "INSERT OR IGNORE INTO network_blocks (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)",
            )
            .run(userId, targetId, now);
          if (!current)
            this.db
              .prepare(
                `INSERT INTO network_connections
          (user_a, user_b, requester_id, status, context, source, created_at, updated_at)
          VALUES (?, ?, ?, 'removed', '', 'qr', ?, ?)`,
              )
              .run(...pair(userId, targetId), userId, now, now);
        } else if (action === "unblock") {
          this.db
            .prepare(
              "DELETE FROM network_blocks WHERE user_id = ? AND blocked_user_id = ?",
            )
            .run(userId, targetId);
          return null;
        } else if (!current || this.blocked(userId, targetId))
          throw new NetworkError("not_available", 403);
        if (action === "accept") {
          if (current!.status === "accepted")
            return this.connectionView(userId, current!);
          if (current!.status !== "pending" || current!.requester_id === userId)
            throw new NetworkError("not_available", 403);
        }
        if (
          action === "decline" &&
          (current!.requester_id === userId || current!.status !== "pending")
        )
          throw new NetworkError("not_available", 403);
        const status = action === "accept" ? "accepted" : "removed";
        if (current)
          this.db
            .prepare(
              "UPDATE network_connections SET status = ?, updated_at = ? WHERE user_a = ? AND user_b = ?",
            )
            .run(status, now, ...pair(userId, targetId));
        if (status === "accepted") {
          this.enqueue(userId);
          this.enqueue(targetId);
        } else {
          const messages = this.db
            .prepare(
              `SELECT * FROM agent_messages WHERE
          (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
            )
            .all(userId, targetId, targetId, userId) as MessageRow[];
          for (const message of messages) {
            const saved = JSON.parse(message.message_json) as AgentMessage;
            this.db
              .prepare(
                "UPDATE agent_messages SET message_json = ?, answers_json = '{}' WHERE id = ?",
              )
              .run(
                JSON.stringify({ ...saved, status: "revoked", response: {} }),
                message.id,
              );
          }
        }
        return current
          ? this.connectionView(userId, this.connection(userId, targetId)!)
          : null;
      })
      .immediate();
  }

  canSee(viewerId: string, targetId: string, field: NetworkField): boolean {
    if (viewerId === targetId) return true;
    if (this.blocked(viewerId, targetId)) return false;
    const settings = this.settings(targetId),
      visibility = settings.visibility[field];
    return (
      visibility !== "private" &&
      (this.isConnected(viewerId, targetId) ||
        (visibility === "network" && settings.discoverable))
    );
  }

  project(viewerId: string, targetId: string): SharedProfile {
    this.requireUser(viewerId);
    const state = this.profile(targetId),
      settings = this.settings(targetId);
    if (
      this.blocked(viewerId, targetId) ||
      (viewerId !== targetId &&
        !this.isConnected(viewerId, targetId) &&
        !settings.discoverable)
    )
      throw new NetworkError("not_available", 403);
    const context = state.context;
    const result: SharedProfile = {
      id: targetId,
      name: context?.profile.name ?? "Sidekick member",
      revision: state.revision,
    };
    if (context && this.canSee(viewerId, targetId, "profile"))
      result.profile = context.profile;
    if (context && this.canSee(viewerId, targetId, "goal"))
      result.goal = context.goal;
    if (context && this.canSee(viewerId, targetId, "trip")) {
      result.trip = context.trip;
      result.area = settings.area;
    }
    if (this.canSee(viewerId, targetId, "events"))
      result.events = this.sharedEvents?.(targetId, viewerId) ?? [];
    return result;
  }

  enqueue(userId: string) {
    this.requireUser(userId);
    this.db
      .prepare(
        `INSERT INTO network_jobs (user_id, version, updated_at) VALUES (?, 1, ?)
      ON CONFLICT(user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at`,
      )
      .run(userId, timestamp());
  }

  private messageRow(id: string) {
    return this.db
      .prepare("SELECT * FROM agent_messages WHERE id = ?")
      .get(id) as MessageRow | undefined;
  }

  private renderMessage(viewerId: string, row: MessageRow): AgentMessage {
    if (![row.from_user_id, row.to_user_id].includes(viewerId))
      throw new NetworkError("not_found", 404);
    const saved = JSON.parse(row.message_json) as AgentMessage;
    const result = { ...saved, response: {} as AgentMessage["response"] };
    if (
      saved.status === "revoked" ||
      !this.isConnected(row.from_user_id, row.to_user_id)
    )
      return { ...result, status: "revoked" };
    if (Date.parse(saved.expiresAt) <= Date.now())
      return { ...result, status: "expired" };
    const projected = this.project(row.from_user_id, row.to_user_id);
    const settings = this.settings(row.to_user_id);
    const answers =
      row.answer_revision === settings.revision
        ? (JSON.parse(row.answers_json) as Partial<
            Record<NetworkField, string>
          >)
        : {};
    for (const field of saved.fields) {
      if (answers[field])
        result.response[field] = {
          status: "shared",
          value: answers[field],
          source: "user_answer",
        };
      else if (!this.canSee(row.from_user_id, row.to_user_id, field))
        result.response[field] = { status: "not_shared" };
      else if (
        projected[field] === undefined ||
        (field === "events" && !projected.events?.length)
      )
        result.response[field] = { status: "unknown" };
      else
        result.response[field] = {
          status: "shared",
          value: projected[field],
          source: "confirmed_profile",
        };
    }
    if (saved.status !== "declined")
      result.status = saved.fields.every(
        (field) => result.response[field]?.status === "shared",
      )
        ? "completed"
        : "needs_user";
    return result;
  }

  messages(userId: string): AgentMessage[] {
    this.requireUser(userId);
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_messages WHERE from_user_id = ? OR to_user_id = ? ORDER BY created_at DESC LIMIT 100",
      )
      .all(userId, userId) as MessageRow[];
    return rows.map((row) => this.renderMessage(userId, row));
  }

  requestInformation(userId: string, input: InformationRequest): AgentMessage {
    const parsed = informationRequestSchema.parse(input);
    this.requireUser(userId);
    const payloadHash = digest(
      JSON.stringify({ ...parsed, fields: [...parsed.fields].sort() }),
    );
    return this.db
      .transaction(() => {
        if (!this.isConnected(userId, parsed.toUserId))
          throw new NetworkError(
            "connection_required",
            403,
            "Connect before asking another agent.",
          );
        const prior = this.db
          .prepare(
            "SELECT * FROM agent_messages WHERE from_user_id = ? AND request_key = ?",
          )
          .get(userId, parsed.requestId) as MessageRow | undefined;
        if (prior) {
          if (prior.payload_hash !== payloadHash)
            throw new NetworkError("request_reused", 409);
          return this.renderMessage(userId, prior);
        }
        const count = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_messages WHERE from_user_id = ? AND created_at > ?",
          )
          .get(userId, new Date(Date.now() - 86400000).toISOString()) as {
          n: number;
        };
        if (count.n >= 40)
          throw new NetworkError(
            "rate_limit",
            429,
            "Try new agent requests tomorrow.",
          );
        const id = randomUUID(),
          now = Date.now();
        const message: AgentMessage = {
          id,
          correlationId: id,
          senderAgentId: `agent:${userId}`,
          recipientAgentId: `agent:${parsed.toUserId}`,
          representedUserId: userId,
          fromUserId: userId,
          toUserId: parsed.toUserId,
          senderName: this.name(userId),
          recipientName: this.name(parsed.toUserId),
          type: "PROFILE_QUERY",
          fields: parsed.fields,
          purpose: parsed.purpose,
          status: "needs_user",
          response: {},
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 7 * 86400000).toISOString(),
        };
        this.db
          .prepare(
            `INSERT INTO agent_messages (id, from_user_id, to_user_id, request_key, payload_hash, message_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            userId,
            parsed.toUserId,
            parsed.requestId,
            payloadHash,
            JSON.stringify(message),
            message.createdAt,
          );
        const result = this.renderMessage(userId, this.messageRow(id)!);
        this.db
          .prepare("UPDATE agent_messages SET message_json = ? WHERE id = ?")
          .run(JSON.stringify(result), id);
        return result;
      })
      .immediate();
  }

  answerInformation(userId: string, input: InformationAnswer): AgentMessage {
    const parsed = informationAnswerSchema.parse(input);
    this.requireUser(userId);
    return this.db
      .transaction(() => {
        const row = this.messageRow(parsed.messageId);
        if (!row || row.to_user_id !== userId)
          throw new NetworkError("not_found", 404);
        const current = this.renderMessage(userId, row);
        if (["expired", "revoked"].includes(current.status))
          throw new NetworkError("request_closed", 409);
        if (
          Object.keys(parsed.answers).some(
            (field) => !current.fields.includes(field as NetworkField),
          )
        )
          throw new NetworkError("invalid_answer", 400);
        const revision = this.settings(userId).revision;
        const prior =
          row.answer_revision === revision
            ? (JSON.parse(row.answers_json) as Partial<
                Record<NetworkField, string>
              >)
            : {};
        if (current.status === "declined" && parsed.decline) return current;
        if (current.status === "declined")
          throw new NetworkError("request_closed", 409);
        if (current.status === "completed") {
          if (
            !parsed.decline &&
            Object.entries(parsed.answers).every(
              ([field, answer]) => prior[field as NetworkField] === answer,
            )
          )
            return current;
          throw new NetworkError("request_closed", 409);
        }
        const saved = JSON.parse(row.message_json) as AgentMessage;
        const answers = { ...prior, ...parsed.answers };
        saved.status = parsed.decline ? "declined" : "needs_user";
        this.db
          .prepare(
            "UPDATE agent_messages SET message_json = ?, answers_json = ?, answer_revision = ? WHERE id = ?",
          )
          .run(
            JSON.stringify(saved),
            JSON.stringify(answers),
            revision,
            row.id,
          );
        const result = this.renderMessage(userId, this.messageRow(row.id)!);
        this.db
          .prepare("UPDATE agent_messages SET message_json = ? WHERE id = ?")
          .run(JSON.stringify(result), row.id);
        return result;
      })
      .immediate();
  }
}
