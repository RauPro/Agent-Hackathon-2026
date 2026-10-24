import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CalendarConnection, CalendarRecord } from "@/lib/domain/calendar";
import {
  contextSchema,
  type ContextState,
  type UserContext,
} from "@/lib/domain/context";
import {
  initialChat,
  refreshWelcome,
  modelReplySchema,
  validateDraft,
  type ChatRequest,
  type ChatState,
  type ModelReply,
} from "@/lib/domain/onboarding-chat";

type SessionRow = {
  token_hash: string;
  revision: number;
  context_json: string | null;
  confirmed_at: string | null;
};
export class ContextConflict extends Error {
  constructor(
    public code: "stale_revision" | "request_reused" | "profile_changed",
  ) {
    super(code);
  }
}
export class SessionMissing extends Error {}
export class CalendarConflict extends Error {
  constructor(public code: "invalid_state" | "calendar_changed") {
    super(code);
  }
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export class ContextStore {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(resolve(path)), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        context_json TEXT,
        confirmed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(token_hash),
        operation_key TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, operation_key)
      );
      CREATE TABLE IF NOT EXISTS onboarding_chats (
        session_id TEXT PRIMARY KEY REFERENCES sessions(token_hash),
        state_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS calendar_connections (
        session_id TEXT PRIMARY KEY REFERENCES sessions(token_hash),
        revision INTEGER NOT NULL,
        connection_json TEXT
      );
      CREATE TABLE IF NOT EXISTS calendar_oauth_states (
        state_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(token_hash),
        encrypted_verifier TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        base_revision INTEGER NOT NULL
      );
    `);
  }

  private session(token: string | undefined): SessionRow | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ?")
      .get(hash(token)) as SessionRow | undefined;
  }

  private state(row: SessionRow): ContextState {
    return {
      context: row.context_json
        ? contextSchema.parse(JSON.parse(row.context_json))
        : null,
      revision: row.revision,
      confirmedAt: row.confirmed_at,
      evidenceKind: row.context_json ? "user_report" : null,
    };
  }

  ensureSession(token?: string): {
    token: string;
    state: ContextState;
    created: boolean;
  } {
    const existing = this.session(token);
    if (existing && token)
      return { token, state: this.state(existing), created: false };
    const nextToken = randomBytes(32).toString("hex");
    this.db
      .prepare("INSERT INTO sessions (token_hash, created_at) VALUES (?, ?)")
      .run(hash(nextToken), new Date().toISOString());
    return { token: nextToken, state: this.read(nextToken)!, created: true };
  }

  read(token?: string): ContextState | null {
    const row = this.session(token);
    return row ? this.state(row) : null;
  }

  save(
    token: string | undefined,
    input: { context: UserContext; baseRevision: number; requestId: string },
  ): ContextState {
    const context = contextSchema.parse(input.context);
    const serialized = JSON.stringify(context);
    const payloadHash = hash(
      JSON.stringify({ context, baseRevision: input.baseRevision }),
    );
    return this.db
      .transaction(() => {
        const current = this.session(token);
        if (!current) throw new SessionMissing();
        const prior = this.db
          .prepare(
            "SELECT payload_hash, result_json FROM runs WHERE session_id = ? AND operation_key = ?",
          )
          .get(current.token_hash, input.requestId) as
          | { payload_hash: string; result_json: string }
          | undefined;
        if (prior) {
          if (prior.payload_hash !== payloadHash)
            throw new ContextConflict("request_reused");
          return JSON.parse(prior.result_json) as ContextState;
        }
        if (current.revision !== input.baseRevision)
          throw new ContextConflict("stale_revision");
        const unchanged = current.context_json === serialized;
        const confirmedAt = unchanged
          ? current.confirmed_at!
          : new Date().toISOString();
        const revision = current.revision + (unchanged ? 0 : 1);
        const state: ContextState = {
          context,
          revision,
          confirmedAt,
          evidenceKind: "user_report",
        };
        this.db
          .prepare(
            "UPDATE sessions SET context_json = ?, revision = ?, confirmed_at = ? WHERE token_hash = ?",
          )
          .run(serialized, revision, confirmedAt, current.token_hash);
        this.db
          .prepare(
            "INSERT INTO runs (id, session_id, operation_key, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            randomUUID(),
            current.token_hash,
            input.requestId,
            payloadHash,
            JSON.stringify(state),
            new Date().toISOString(),
          );
        return state;
      })
      .immediate();
  }

  readChat(token: string | undefined): ChatState {
    const session = this.session(token);
    if (!session) throw new SessionMissing();
    const existing = this.db
      .prepare("SELECT state_json FROM onboarding_chats WHERE session_id = ?")
      .get(session.token_hash) as { state_json: string } | undefined;
    if (existing)
      return refreshWelcome(JSON.parse(existing.state_json) as ChatState);
    const chat = initialChat(this.state(session));
    this.db
      .prepare(
        "INSERT INTO onboarding_chats (session_id, state_json) VALUES (?, ?)",
      )
      .run(session.token_hash, JSON.stringify(chat));
    return chat;
  }

  cachedChat(
    token: string | undefined,
    request: ChatRequest,
  ): ChatState | null {
    const session = this.session(token);
    if (!session) throw new SessionMissing();
    const prior = this.db
      .prepare(
        "SELECT payload_hash, result_json FROM runs WHERE session_id = ? AND operation_key = ?",
      )
      .get(session.token_hash, `chat:${request.requestId}`) as
      | { payload_hash: string; result_json: string }
      | undefined;
    if (!prior) return null;
    if (prior.payload_hash !== hash(JSON.stringify(request)))
      throw new ContextConflict("request_reused");
    return refreshWelcome(JSON.parse(prior.result_json) as ChatState);
  }

  checkChat(token: string | undefined, request: ChatRequest): ChatState {
    const chat = this.readChat(token);
    if (chat.revision !== request.revision)
      throw new ContextConflict("stale_revision");
    if (
      request.action !== "reload_saved" &&
      this.read(token)!.revision !== chat.baseRevision
    )
      throw new ContextConflict("profile_changed");
    return chat;
  }

  commitChat(
    token: string | undefined,
    request: ChatRequest,
    reply?: ModelReply,
  ): ChatState {
    return this.db
      .transaction(() => {
        const cached = this.cachedChat(token, request);
        if (cached) return cached;
        const current = this.checkChat(token, request);
        let next: ChatState;
        if (request.action === "message") {
          const parsed = modelReplySchema.parse(reply);
          next = {
            ...current,
            revision: current.revision + 1,
            confirmed:
              current.confirmed &&
              JSON.stringify(parsed.draft) === JSON.stringify(current.draft),
            draft: parsed.draft,
            messages: [
              ...current.messages,
              { id: request.requestId, role: "user", content: request.message },
              { id: randomUUID(), role: "assistant", content: parsed.reply },
            ],
          };
        } else if (request.action === "confirm") {
          const profile = validateDraft(current.draft);
          if (!profile.success) throw new Error("draft_incomplete");
          const saved = this.save(token, {
            context: profile.data,
            baseRevision: current.baseRevision,
            requestId: `chat-confirm:${request.requestId}`,
          });
          next = {
            ...current,
            revision: current.revision + 1,
            baseRevision: saved.revision,
            confirmed: true,
          };
        } else {
          next = {
            ...initialChat(this.read(token)!),
            revision: current.revision + 1,
          };
        }
        const sessionId = this.session(token)!.token_hash;
        this.db
          .prepare(
            "UPDATE onboarding_chats SET state_json = ? WHERE session_id = ?",
          )
          .run(JSON.stringify(next), sessionId);
        this.db
          .prepare(
            "INSERT INTO runs (id, session_id, operation_key, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            randomUUID(),
            sessionId,
            `chat:${request.requestId}`,
            hash(JSON.stringify(request)),
            JSON.stringify(next),
            new Date().toISOString(),
          );
        return next;
      })
      .immediate();
  }

  calendarOwner(token: string | undefined) {
    const session = this.session(token);
    if (!session) throw new SessionMissing();
    return session.token_hash;
  }

  readCalendar(token: string | undefined): CalendarRecord {
    const row = this.db
      .prepare(
        "SELECT revision, connection_json FROM calendar_connections WHERE session_id = ?",
      )
      .get(this.calendarOwner(token)) as
      | { revision: number; connection_json: string | null }
      | undefined;
    return {
      revision: row?.revision ?? 0,
      connection: row?.connection_json
        ? (JSON.parse(row.connection_json) as CalendarConnection)
        : null,
    };
  }

  writeCalendar(
    token: string | undefined,
    revision: number,
    connection: CalendarConnection | null,
  ): CalendarRecord {
    return this.db
      .transaction(() => {
        const owner = this.calendarOwner(token);
        if (this.readCalendar(token).revision !== revision)
          throw new CalendarConflict("calendar_changed");
        const next = { revision: revision + 1, connection };
        this.db
          .prepare(
            "INSERT INTO calendar_connections (session_id, revision, connection_json) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, connection_json = excluded.connection_json",
          )
          .run(
            owner,
            next.revision,
            connection ? JSON.stringify(connection) : null,
          );
        return next;
      })
      .immediate();
  }

  startCalendarOAuth(
    token: string,
    state: string,
    encryptedVerifier: string,
    now = Date.now(),
  ) {
    this.db
      .transaction(() => {
        const owner = this.calendarOwner(token);
        this.db
          .prepare(
            "DELETE FROM calendar_oauth_states WHERE session_id = ? OR expires_at <= ?",
          )
          .run(owner, now);
        this.db
          .prepare(
            "INSERT INTO calendar_oauth_states (state_hash, session_id, encrypted_verifier, expires_at, base_revision) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            hash(state),
            owner,
            encryptedVerifier,
            now + 10 * 60 * 1000,
            this.readCalendar(token).revision,
          );
      })
      .immediate();
  }

  consumeCalendarOAuth(
    token: string | undefined,
    state: string,
    now = Date.now(),
  ) {
    const result = this.db
      .transaction(() => {
        const owner = this.calendarOwner(token);
        const row = this.db
          .prepare(
            "SELECT encrypted_verifier, expires_at, base_revision FROM calendar_oauth_states WHERE state_hash = ? AND session_id = ?",
          )
          .get(hash(state), owner) as
          | {
              encrypted_verifier: string;
              expires_at: number;
              base_revision: number;
            }
          | undefined;
        if (!row) throw new CalendarConflict("invalid_state");
        this.db
          .prepare(
            "DELETE FROM calendar_oauth_states WHERE state_hash = ? AND session_id = ?",
          )
          .run(hash(state), owner);
        return row;
      })
      .immediate();
    if (result.expires_at <= now) throw new CalendarConflict("invalid_state");
    return result;
  }

  connectCalendar(
    token: string,
    revision: number,
    connectionForOwner: (owner: string) => CalendarConnection,
  ): string {
    return this.db
      .transaction(() => {
        const owner = this.calendarOwner(token);
        if (this.readCalendar(token).revision !== revision)
          throw new CalendarConflict("calendar_changed");
        const nextToken = randomBytes(32).toString("hex"),
          nextOwner = hash(nextToken);
        const connection = connectionForOwner(nextOwner);
        this.db
          .prepare(
            "INSERT INTO sessions (token_hash, revision, context_json, confirmed_at, created_at) SELECT ?, revision, context_json, confirmed_at, created_at FROM sessions WHERE token_hash = ?",
          )
          .run(nextOwner, owner);
        this.db
          .prepare("UPDATE runs SET session_id = ? WHERE session_id = ?")
          .run(nextOwner, owner);
        this.db
          .prepare(
            "UPDATE onboarding_chats SET session_id = ? WHERE session_id = ?",
          )
          .run(nextOwner, owner);
        this.db
          .prepare("DELETE FROM calendar_oauth_states WHERE session_id = ?")
          .run(owner);
        this.db
          .prepare("DELETE FROM calendar_connections WHERE session_id = ?")
          .run(owner);
        this.db
          .prepare(
            "INSERT INTO calendar_connections (session_id, revision, connection_json) VALUES (?, ?, ?)",
          )
          .run(nextOwner, revision + 1, JSON.stringify(connection));
        this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(owner);
        return nextToken;
      })
      .immediate();
  }

  close() {
    this.db.close();
  }
}

const globalStore = globalThis as typeof globalThis & {
  sidekickStore?: ContextStore;
};
export function getStore() {
  return (globalStore.sidekickStore ??= new ContextStore(
    process.env.DATABASE_PATH || "./data/sidekick.sqlite",
  ));
}
