import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { contextSchema, type ContextState, type UserContext } from "@/lib/domain/context";

type SessionRow = { token_hash: string; revision: number; context_json: string | null; confirmed_at: string | null };
export class ContextConflict extends Error {
  constructor(public code: "stale_revision" | "request_reused") { super(code); }
}
export class SessionMissing extends Error {}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export class ContextStore {
  private db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
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
    `);
  }

  private session(token: string | undefined): SessionRow | undefined {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hash(token)) as SessionRow | undefined;
  }

  private state(row: SessionRow): ContextState {
    return {
      context: row.context_json ? contextSchema.parse(JSON.parse(row.context_json)) : null,
      revision: row.revision,
      confirmedAt: row.confirmed_at,
      evidenceKind: row.context_json ? "user_report" : null,
    };
  }

  ensureSession(token?: string): { token: string; state: ContextState; created: boolean } {
    const existing = this.session(token);
    if (existing && token) return { token, state: this.state(existing), created: false };
    const nextToken = randomBytes(32).toString("hex");
    this.db.prepare("INSERT INTO sessions (token_hash, created_at) VALUES (?, ?)").run(hash(nextToken), new Date().toISOString());
    return { token: nextToken, state: this.read(nextToken)!, created: true };
  }

  read(token?: string): ContextState | null {
    const row = this.session(token);
    return row ? this.state(row) : null;
  }

  save(token: string | undefined, input: { context: UserContext; baseRevision: number; requestId: string }): ContextState {
    const context = contextSchema.parse(input.context);
    const serialized = JSON.stringify(context);
    const payloadHash = hash(JSON.stringify({ context, baseRevision: input.baseRevision }));
    return this.db.transaction(() => {
      const current = this.session(token);
      if (!current) throw new SessionMissing();
      const prior = this.db.prepare("SELECT payload_hash, result_json FROM runs WHERE session_id = ? AND operation_key = ?")
        .get(current.token_hash, input.requestId) as { payload_hash: string; result_json: string } | undefined;
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new ContextConflict("request_reused");
        return JSON.parse(prior.result_json) as ContextState;
      }
      if (current.revision !== input.baseRevision) throw new ContextConflict("stale_revision");
      const unchanged = current.context_json === serialized;
      const confirmedAt = unchanged ? current.confirmed_at! : new Date().toISOString();
      const revision = current.revision + (unchanged ? 0 : 1);
      const state: ContextState = { context, revision, confirmedAt, evidenceKind: "user_report" };
      this.db.prepare("UPDATE sessions SET context_json = ?, revision = ?, confirmed_at = ? WHERE token_hash = ?")
        .run(serialized, revision, confirmedAt, current.token_hash);
      this.db.prepare("INSERT INTO runs (id, session_id, operation_key, payload_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), current.token_hash, input.requestId, payloadHash, JSON.stringify(state), new Date().toISOString());
      return state;
    }).immediate();
  }

  close() { this.db.close(); }
}

const globalStore = globalThis as typeof globalThis & { sidekickStore?: ContextStore };
export function getStore() {
  return globalStore.sidekickStore ??= new ContextStore(process.env.DATABASE_PATH || "./data/sidekick.sqlite");
}
