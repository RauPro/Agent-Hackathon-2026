import type { AsyncDatabase } from "./database";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { contextSchema, type ContextState } from "../domain/context";
import {
  connectionRequestSchema,
  informationAnswerSchema,
  informationRequestSchema,
  networkSettingsSchema,
  type AgentActivityEntry,
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
  status: "pending" | "accepted" | "removed" | "declined";
  context: string;
  source: "qr" | "opportunity";
  created_at: string;
  updated_at: string;
  revision: number;
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
  canContactFromOpportunity?: (
    viewerId: string,
    targetId: string,
  ) => Promise<boolean>;
  sharedEvents?: (ownerId: string, viewerId: string) => Promise<SharedEvent[]>;
  constructor(readonly db: AsyncDatabase) {}
  private async requireUser(userId: string) {
    if (
      !(await this.db.prepare("SELECT 1 FROM users WHERE id = ?").get(userId))
    )
      throw new NetworkError("not_found", 404);
  }
  async profile(userId: string): Promise<ContextState> {
    const row = (await this.db
      .prepare(
        `SELECT s.context_json, s.revision, s.confirmed_at
      FROM users u JOIN sessions s ON s.token_hash = u.profile_id WHERE u.id = ?`,
      )
      .get(userId)) as
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
  private async name(userId: string) {
    return (
      (await this.profile(userId)).context?.profile.name ?? "Sidekick member"
    );
  }
  async settings(userId: string): Promise<NetworkSettings> {
    const existing = (await this.db
      .prepare(
        "SELECT ns.settings_json, ns.qr_token FROM users u LEFT JOIN network_settings ns ON ns.user_id = u.id WHERE u.id = ?",
      )
      .get(userId)) as
      | {
          settings_json: string;
          qr_token: string;
        }
      | undefined;
    if (!existing) throw new NetworkError("not_found", 404);
    if (existing.settings_json)
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
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO network_settings (user_id, settings_json, qr_token) VALUES (?, ?, ?)",
      )
      .run(userId, JSON.stringify(input), qrToken);
    return await this.settings(userId);
  }
  async saveSettings(
    userId: string,
    input: NetworkSettingsInput,
  ): Promise<NetworkSettings> {
    const parsed = networkSettingsSchema.parse(input);
    return this.db
      .transaction(async () => {
        const current = await this.settings(userId);
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
        await this.db
          .prepare(
            "UPDATE network_settings SET settings_json = ? WHERE user_id = ?",
          )
          .run(JSON.stringify(next), userId);
        await this.enqueue(userId);
        return { ...next, qrToken: current.qrToken };
      })
      .immediate();
  }
  async rotateQr(userId: string): Promise<NetworkSettings> {
    await this.settings(userId);
    await this.db
      .prepare("UPDATE network_settings SET qr_token = ? WHERE user_id = ?")
      .run(randomBytes(32).toString("base64url"), userId);
    return await this.settings(userId);
  }
  async resolveQr(
    viewerId: string,
    token: string,
  ): Promise<{
    id: string;
    name: string;
  }> {
    await this.requireUser(viewerId);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new NetworkError("not_found", 404);
    const row = (await this.db
      .prepare("SELECT user_id FROM network_settings WHERE qr_token = ?")
      .get(token)) as
      | {
          user_id: string;
        }
      | undefined;
    if (
      !row ||
      row.user_id === viewerId ||
      (await this.blocked(viewerId, row.user_id))
    )
      throw new NetworkError("not_found", 404);
    return { id: row.user_id, name: await this.name(row.user_id) };
  }
  async blocked(a: string, b: string): Promise<boolean> {
    return !!(await this.db
      .prepare(
        `SELECT 1 FROM network_blocks WHERE
      (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)`,
      )
      .get(a, b, b, a));
  }
  private async connection(a: string, b: string) {
    return (await this.db
      .prepare(
        "SELECT * FROM network_connections WHERE user_a = ? AND user_b = ?",
      )
      .get(...pair(a, b))) as ConnectionRow | undefined;
  }
  async isConnected(a: string, b: string): Promise<boolean> {
    if (a === b) return false;
    return !!(await this.db
      .prepare(
        `SELECT 1 FROM network_connections
            WHERE user_a = ? AND user_b = ? AND status = 'accepted'
            AND NOT EXISTS (SELECT 1 FROM network_blocks WHERE
                (user_id = ? AND blocked_user_id = ?) OR
                (user_id = ? AND blocked_user_id = ?))`,
      )
      .get(...pair(a, b), a, b, b, a));
  }
  async relationshipRevision(a: string, b: string): Promise<number> {
    return (await this.connection(a, b))?.revision ?? 0;
  }
  private async connectionView(
    userId: string,
    row: ConnectionRow,
  ): Promise<ConnectionView> {
    const peer = row.user_a === userId ? row.user_b : row.user_a;
    return {
      userId: peer,
      name: await this.name(peer),
      status: (await this.blocked(userId, peer))
        ? "blocked"
        : row.status === "declined"
          ? "removed"
          : row.status,
      direction: row.requester_id === userId ? "outgoing" : "incoming",
      context: row.context,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  async connections(userId: string): Promise<ConnectionView[]> {
    await this.requireUser(userId);
    const rows = (await this.db
      .prepare(
        `SELECT * FROM network_connections WHERE user_a = ? OR user_b = ? ORDER BY updated_at DESC`,
      )
      .all(userId, userId)) as ConnectionRow[];
    const result: ConnectionView[] = [];
    for (const row of rows) {
      if (
        !["removed", "declined"].includes(row.status) ||
        (await this.blocked(row.user_a, row.user_b))
      )
        result.push(await this.connectionView(userId, row));
    }
    return result;
  }
  async requestConnection(
    userId: string,
    targetId: string,
    input: ConnectionRequest,
  ): Promise<ConnectionView> {
    const parsed = connectionRequestSchema.parse(input);
    await this.requireUser(userId);
    await this.requireUser(targetId);
    return this.db
      .transaction(async () => {
        if (userId === targetId || (await this.blocked(userId, targetId)))
          throw new NetworkError("not_available", 403);
        if (parsed.source === "qr") {
          if (
            !parsed.token ||
            (await this.resolveQr(userId, parsed.token)).id !== targetId
          )
            throw new NetworkError("not_available", 403);
        } else if (!(await this.canContactFromOpportunity?.(userId, targetId)))
          throw new NetworkError("not_available", 403);
        const current = await this.connection(userId, targetId);
        if (
          current?.status === "declined" &&
          Date.now() - Date.parse(current.updated_at) < 86400000
        )
          throw new NetworkError(
            "connection_cooldown",
            429,
            "This connection request was declined. Wait a day before trying again.",
          );
        if (current && !["removed", "declined"].includes(current.status))
          return await this.connectionView(userId, current);
        const count = (await this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM network_connections WHERE requester_id = ? AND updated_at > ?",
          )
          .get(userId, new Date(Date.now() - 86400000).toISOString())) as {
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
        await this.db
          .prepare(
            `INSERT INTO network_connections (user_a, user_b, requester_id, status, context, source, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT(user_a, user_b) DO UPDATE SET
        requester_id = excluded.requester_id, status = 'pending', context = excluded.context, source = excluded.source,
        created_at = excluded.created_at, updated_at = excluded.updated_at, revision = revision + 1`,
          )
          .run(a, b, userId, parsed.context, parsed.source, now, now);
        return await this.connectionView(
          userId,
          (await this.connection(userId, targetId))!,
        );
      })
      .immediate();
  }
  async connectionAction(
    userId: string,
    targetId: string,
    action: ConnectionAction,
  ): Promise<ConnectionView | null> {
    await this.requireUser(userId);
    await this.requireUser(targetId);
    if (!["accept", "decline", "remove", "block", "unblock"].includes(action))
      throw new NetworkError("invalid_action");
    if (userId === targetId) throw new NetworkError("not_available", 403);
    return this.db
      .transaction(async () => {
        const current = await this.connection(userId, targetId),
          now = timestamp();
        if (action === "block") {
          await this.db
            .prepare(
              "INSERT OR IGNORE INTO network_blocks (user_id, blocked_user_id, created_at) VALUES (?, ?, ?)",
            )
            .run(userId, targetId, now);
          if (!current)
            await this.db
              .prepare(
                `INSERT INTO network_connections
          (user_a, user_b, requester_id, status, context, source, created_at, updated_at)
          VALUES (?, ?, ?, 'removed', '', 'qr', ?, ?)`,
              )
              .run(...pair(userId, targetId), userId, now, now);
        } else if (action === "unblock") {
          const removed = await this.db
            .prepare(
              "DELETE FROM network_blocks WHERE user_id = ? AND blocked_user_id = ?",
            )
            .run(userId, targetId);
          if (removed.changes)
            await this.db
              .prepare(
                "UPDATE network_connections SET revision = revision + 1, updated_at = ? WHERE user_a = ? AND user_b = ?",
              )
              .run(now, ...pair(userId, targetId));
          return null;
        } else if (!current || (await this.blocked(userId, targetId)))
          throw new NetworkError("not_available", 403);
        if (action === "accept") {
          if (current!.status === "accepted")
            return await this.connectionView(userId, current!);
          if (current!.status !== "pending" || current!.requester_id === userId)
            throw new NetworkError("not_available", 403);
        }
        if (
          action === "decline" &&
          (current!.requester_id === userId || current!.status !== "pending")
        )
          throw new NetworkError("not_available", 403);
        if (action === "remove" && current?.status === "declined")
          return await this.connectionView(userId, current);
        const status =
          action === "accept"
            ? "accepted"
            : action === "decline" || current?.status === "declined"
              ? "declined"
              : "removed";
        if (current)
          await this.db
            .prepare(
              "UPDATE network_connections SET status = ?, updated_at = ?, revision = revision + 1 WHERE user_a = ? AND user_b = ?",
            )
            .run(status, now, ...pair(userId, targetId));
        if (status === "accepted") {
          await this.enqueue(userId);
          await this.enqueue(targetId);
        } else {
          const messages = (await this.db
            .prepare(
              `SELECT * FROM agent_messages WHERE
          (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)`,
            )
            .all(userId, targetId, targetId, userId)) as MessageRow[];
          for (const message of messages) {
            const saved = JSON.parse(message.message_json) as AgentMessage;
            await this.db
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
          ? await this.connectionView(
              userId,
              (await this.connection(userId, targetId))!,
            )
          : null;
      })
      .immediate();
  }
  async canSee(
    viewerId: string,
    targetId: string,
    field: NetworkField,
  ): Promise<boolean> {
    if (viewerId === targetId) return true;
    if (await this.blocked(viewerId, targetId)) return false;
    const settings = await this.settings(targetId),
      visibility = settings.visibility[field];
    return (
      visibility !== "private" &&
      ((await this.isConnected(viewerId, targetId)) ||
        (visibility === "network" && settings.discoverable))
    );
  }
  async project(viewerId: string, targetId: string): Promise<SharedProfile> {
    // One permission snapshot avoids repeated remote reads inside short write transactions.
    const row = (await this.db
      .prepare(
        `SELECT s.context_json, s.revision, ns.settings_json,
      EXISTS(SELECT 1 FROM network_blocks WHERE
        (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)) AS blocked,
      EXISTS(SELECT 1 FROM network_connections WHERE user_a = ? AND user_b = ? AND status = 'accepted') AS connected
      FROM users u JOIN sessions s ON s.token_hash = u.profile_id
      LEFT JOIN network_settings ns ON ns.user_id = u.id
      WHERE u.id = ? AND EXISTS(SELECT 1 FROM users WHERE id = ?)`,
      )
      .get(
        viewerId,
        targetId,
        targetId,
        viewerId,
        ...pair(viewerId, targetId),
        targetId,
        viewerId,
      )) as
      | {
          context_json: string | null;
          revision: number;
          settings_json: string | null;
          blocked: number;
          connected: number;
        }
      | undefined;
    if (!row) throw new NetworkError("not_found", 404);
    const settings = row.settings_json
      ? networkSettingsSchema.parse(JSON.parse(row.settings_json))
      : {
          discoverable: false,
          visibility: {
            profile: "private",
            goal: "private",
            trip: "private",
            events: "private",
          },
          area: null,
        };
    const connected = !!row.connected;
    if (
      row.blocked ||
      (viewerId !== targetId && !connected && !settings.discoverable)
    )
      throw new NetworkError("not_available", 403);
    const allowed = (field: NetworkField) =>
      viewerId === targetId ||
      (settings.visibility[field] !== "private" &&
        (connected ||
          (settings.visibility[field] === "network" && settings.discoverable)));
    const context = row.context_json
      ? contextSchema.parse(JSON.parse(row.context_json))
      : null;
    const result: SharedProfile = {
      id: targetId,
      name: context?.profile.name ?? "Sidekick member",
      revision: row.revision,
    };
    if (context && allowed("profile")) result.profile = context.profile;
    if (context && allowed("goal")) result.goal = context.goal;
    if (context && allowed("trip")) {
      result.trip = context.trip;
      result.area = settings.area;
    }
    if (allowed("events"))
      result.events = (await this.sharedEvents?.(targetId, viewerId)) ?? [];
    return result;
  }
  async enqueue(userId: string) {
    await this.requireUser(userId);
    await this.db
      .prepare(
        `INSERT INTO network_jobs (user_id, version, updated_at, cursor, priority) VALUES (?, 1, ?, '', 1)
      ON CONFLICT(user_id) DO UPDATE SET version = version + 1, updated_at = excluded.updated_at, cursor = '', priority = 1`,
      )
      .run(userId, timestamp());
  }
  private async messageRow(id: string) {
    return (await this.db
      .prepare("SELECT * FROM agent_messages WHERE id = ?")
      .get(id)) as MessageRow | undefined;
  }
  private savedActivity(message: AgentMessage): AgentActivityEntry[] {
    // Older records have no response timestamp. Preserve only their known request.
    return (
      message.activity ?? [
        {
          id: `${message.id}:request`,
          at: message.createdAt,
          actorUserId: message.fromUserId,
          kind: "request",
          fields: message.fields,
        },
      ]
    );
  }
  private visibleActivity(
    message: AgentMessage,
    accessible: boolean,
    settings: NetworkSettings | null,
    projected: SharedProfile | null,
  ): AgentActivityEntry[] {
    const visibleEventIds = new Set(
      projected?.events?.map((event) => event.id) ?? [],
    );
    return this.savedActivity(message).map((entry) => {
      if (!entry.response) return { ...entry };
      const response: AgentMessage["response"] = {};
      for (const field of message.fields) {
        const snapshot = entry.response[field];
        if (!snapshot) continue;
        const allowed =
          accessible &&
          !!settings &&
          (snapshot.source === "user_answer"
            ? entry.shareRevision === settings.revision
            : settings.visibility[field] !== "private");
        if (allowed && field === "events" && Array.isArray(snapshot.value)) {
          const events = snapshot.value.filter((event) =>
            visibleEventIds.has(event.id),
          );
          response[field] = events.length
            ? { ...snapshot, value: events }
            : { status: "not_shared" };
        } else response[field] = allowed ? snapshot : { status: "not_shared" };
      }
      return { ...entry, response };
    });
  }
  private async renderMessage(
    viewerId: string,
    row: MessageRow,
  ): Promise<AgentMessage> {
    if (![row.from_user_id, row.to_user_id].includes(viewerId))
      throw new NetworkError("not_found", 404);
    const saved = JSON.parse(row.message_json) as AgentMessage;
    const revoked =
      saved.status === "revoked" ||
      !(await this.isConnected(row.from_user_id, row.to_user_id));
    const expired = Date.parse(saved.expiresAt) <= Date.now();
    const accessible = !revoked && !expired;
    const projected = accessible
      ? await this.project(row.from_user_id, row.to_user_id)
      : null;
    const settings = accessible ? await this.settings(row.to_user_id) : null;
    const result: AgentMessage = {
      ...saved,
      trigger: saved.trigger ?? "user",
      activity: this.visibleActivity(saved, accessible, settings, projected),
      response: {},
    };
    if (revoked) return { ...result, status: "revoked" };
    if (expired) return { ...result, status: "expired" };
    const answers =
      row.answer_revision === settings!.revision
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
      else if (settings!.visibility[field] === "private")
        result.response[field] = { status: "not_shared" };
      else if (
        projected![field] === undefined ||
        (field === "events" && !projected!.events?.length)
      )
        result.response[field] = { status: "unknown" };
      else
        result.response[field] = {
          status: "shared",
          value: projected![field],
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
  async messages(userId: string): Promise<AgentMessage[]> {
    await this.requireUser(userId);
    const rows = (await this.db
      .prepare(
        "SELECT * FROM agent_messages WHERE from_user_id = ? OR to_user_id = ? ORDER BY created_at DESC LIMIT 100",
      )
      .all(userId, userId)) as MessageRow[];
    return Promise.all(rows.map((row) => this.renderMessage(userId, row)));
  }
  async requestInformation(
    userId: string,
    input: InformationRequest,
    options: {
      trigger: AgentMessage["trigger"];
    } = { trigger: "user" },
  ): Promise<AgentMessage> {
    const parsed = informationRequestSchema.parse(input);
    await this.requireUser(userId);
    const payloadHash = digest(
      JSON.stringify({ ...parsed, fields: [...parsed.fields].sort() }),
    );
    return this.db
      .transaction(async () => {
        if (!(await this.isConnected(userId, parsed.toUserId)))
          throw new NetworkError(
            "connection_required",
            403,
            "Connect before asking another agent.",
          );
        const prior = (await this.db
          .prepare(
            "SELECT * FROM agent_messages WHERE from_user_id = ? AND request_key = ?",
          )
          .get(userId, parsed.requestId)) as MessageRow | undefined;
        if (prior) {
          if (prior.payload_hash !== payloadHash)
            throw new NetworkError("request_reused", 409);
          return await this.renderMessage(userId, prior);
        }
        const count = (await this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_messages WHERE from_user_id = ? AND created_at > ?",
          )
          .get(userId, new Date(Date.now() - 86400000).toISOString())) as {
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
          senderName: await this.name(userId),
          recipientName: await this.name(parsed.toUserId),
          type: "PROFILE_QUERY",
          trigger: options.trigger,
          fields: parsed.fields,
          purpose: parsed.purpose,
          status: "needs_user",
          response: {},
          activity: [
            {
              id: randomUUID(),
              at: new Date(now).toISOString(),
              actorUserId: userId,
              kind: "request",
              fields: parsed.fields,
            },
          ],
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 7 * 86400000).toISOString(),
        };
        await this.db
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
        const result = await this.renderMessage(
          userId,
          (await this.messageRow(id))!,
        );
        const sharedFields = parsed.fields.filter(
          (field) => result.response[field]?.status === "shared",
        );
        if (sharedFields.length)
          result.activity.push({
            id: randomUUID(),
            at: timestamp(),
            actorUserId: parsed.toUserId,
            kind: "response",
            fields: sharedFields,
            response: Object.fromEntries(
              sharedFields.map((field) => [field, result.response[field]]),
            ),
          });
        const pendingFields = parsed.fields.filter(
          (field) => result.response[field]?.status !== "shared",
        );
        if (pendingFields.length)
          result.activity.push({
            id: randomUUID(),
            at: timestamp(),
            actorUserId: parsed.toUserId,
            kind: "permission_needed",
            fields: pendingFields,
          });
        await this.db
          .prepare("UPDATE agent_messages SET message_json = ? WHERE id = ?")
          .run(JSON.stringify(result), id);
        return result;
      })
      .immediate();
  }
  async answerInformation(
    userId: string,
    input: InformationAnswer,
  ): Promise<AgentMessage> {
    const parsed = informationAnswerSchema.parse(input);
    await this.requireUser(userId);
    return this.db
      .transaction(async () => {
        const row = await this.messageRow(parsed.messageId);
        if (!row || row.to_user_id !== userId)
          throw new NetworkError("not_found", 404);
        const current = await this.renderMessage(userId, row);
        if (["expired", "revoked"].includes(current.status))
          throw new NetworkError("request_closed", 409);
        if (
          Object.keys(parsed.answers).some(
            (field) => !current.fields.includes(field as NetworkField),
          )
        )
          throw new NetworkError("invalid_answer", 400);
        const revision = (await this.settings(userId)).revision;
        const prior =
          row.answer_revision === revision
            ? (JSON.parse(row.answers_json) as Partial<
                Record<NetworkField, string>
              >)
            : {};
        if (current.status === "declined" && parsed.decline) return current;
        if (current.status === "declined")
          throw new NetworkError("request_closed", 409);
        if (
          !parsed.decline &&
          Object.entries(parsed.answers).every(
            ([field, answer]) => prior[field as NetworkField] === answer,
          )
        )
          return current;
        if (current.status === "completed") {
          throw new NetworkError("request_closed", 409);
        }
        const saved = JSON.parse(row.message_json) as AgentMessage;
        const answers = { ...prior, ...parsed.answers };
        saved.status = parsed.decline ? "declined" : "needs_user";
        const fields = Object.keys(parsed.answers) as NetworkField[];
        saved.activity = [
          ...this.savedActivity(saved),
          {
            id: randomUUID(),
            at: timestamp(),
            actorUserId: userId,
            kind: parsed.decline ? "declined" : "user_answer",
            ...(parsed.decline
              ? {}
              : {
                  fields,
                  shareRevision: revision,
                  response: Object.fromEntries(
                    fields.map((field) => [
                      field,
                      {
                        status: "shared" as const,
                        source: "user_answer" as const,
                        value: parsed.answers[field],
                      },
                    ]),
                  ),
                }),
          },
        ];
        await this.db
          .prepare(
            "UPDATE agent_messages SET message_json = ?, answers_json = ?, answer_revision = ? WHERE id = ?",
          )
          .run(
            JSON.stringify(saved),
            JSON.stringify(answers),
            revision,
            row.id,
          );
        const result = await this.renderMessage(
          userId,
          (await this.messageRow(row.id))!,
        );
        // Store the immutable history, not its permission-filtered projection.
        await this.db
          .prepare("UPDATE agent_messages SET message_json = ? WHERE id = ?")
          .run(
            JSON.stringify({
              ...saved,
              status: result.status,
              response: result.response,
            }),
            row.id,
          );
        return result;
      })
      .immediate();
  }
}
